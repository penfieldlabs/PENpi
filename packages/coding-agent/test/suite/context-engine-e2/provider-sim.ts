/**
 * Provider simulator. Wraps the session's stream function (in front of Pi's faux provider, which still
 * produces the scripted responses) and behaves like a provider whose tokenizer is real:
 *   - renders each request with the tokenizer's chat template (render.ts) and counts it: tool schemas,
 *     per-message framing, images by the provider's rule;
 *   - usage.input = that count (no cache split), usage.output = the response counted the same way;
 *   - above `limit` input tokens: mode "reject" answers with an overflow error in one of three styles;
 *     mode "silent-truncate" drops part of the request and reports the reduced count instead, in one of
 *     two styles: "front" (token level, Ollama) or "messages" (whole oldest messages).
 * The synthetic payload goes through onPayload, so the engine's before_provider_request hook runs.
 */
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import type { Harness } from "../harness.ts";
import { type RenderedRequest, renderRequest, type Segment } from "./render.ts";
import type { CountingTokenizer, TokenizerName } from "./tokenizers.ts";

export type ErrorStyle = "anthropic" | "openai" | "none";
export const ERROR_STYLES: ErrorStyle[] = ["anthropic", "openai", "none"];
export type ProviderMode = "reject" | "silent-truncate";
/**
 * front:    token level, as Ollama's runner does (inputs[:numKeep] + inputs[numKeep+discard:], numKeep = 4):
 *           keep the first 4 tokens and the newest (limit - 4); usage reports exactly `limit`.
 * messages: drop whole messages after the system prompt and tool schemas, oldest first, until the rest
 *           fits (the last message is always kept); usage reports the real count of what was kept, so it
 *           varies from request to request.
 */
export type TruncationStyle = "front" | "messages";

/** Overflow error text as Pi's providers surface it. */
export function overflowError(style: ErrorStyle, input: number, limit: number, callIndex = 0): string {
	switch (style) {
		case "anthropic":
			return `Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: ${input} tokens > ${limit} maximum"},"request_id":"req_011E2${String(callIndex).padStart(6, "0")}"}`;
		case "openai":
			return `400 This model's maximum context length is ${limit} tokens. However, your messages resulted in ${input} tokens. Please reduce the length of the messages.`;
		case "none":
			return "Your input exceeds the context window of this model. Please adjust your input and try again.";
	}
}

export interface SimCall {
	index: number;
	/** Real tokens of the request as the engine sent it. */
	input: number;
	/** Tokens the provider processed and reported (lower when it truncated silently). */
	processed: number;
	limit: number;
	rejected: boolean;
	errorText?: string;
	truncated: boolean;
	truncatedTokens: number;
	/** Leading segments the truncation removed completely. */
	droppedSegments: number;
	images: number;
	imageTokens: number;
	segments: number;
	/** Segment identities without the reply priming (prefix analysis). */
	keys: string[];
	/** The last message carries the engine's request-only notice. */
	noticeTail: boolean;
	maxTokens?: number;
	output?: number;
	/** Timestamp of the answer to this request (the engine names truncated answers by it). */
	answerAt?: number;
	/** Engine state when the request was sent (filled by the observer). */
	observed?: Record<string, number | undefined>;
}

export interface ProviderSim {
	calls: SimCall[];
	tokenizer: TokenizerName;
}

export interface SimOptions {
	tokenizer: TokenizerName;
	counter: CountingTokenizer;
	limit: number;
	mode: ProviderMode;
	errorStyle: ErrorStyle;
	truncation?: TruncationStyle;
	noticeMarker?: string;
	/** Called for every request before the provider decides (records engine state). */
	observe?: (call: SimCall) => void;
	/** Called for a silently truncated request with the segments it removed (E2_DUMP_DROPPED). */
	onTruncate?: (index: number, removed: Segment[]) => void;
}

function truncate(
	rendered: RenderedRequest,
	limit: number,
	style: TruncationStyle,
): { processed: number; dropped: number; removed: Segment[] } {
	const body = rendered.segments;
	const removed: Segment[] = [];
	if (style === "front") {
		// Ollama runner: inputs[:numKeep] + inputs[numKeep+discard:], numKeep = 4.
		const discardEnd = 4 + (rendered.tokens - limit);
		let acc = 0;
		let dropped = 0;
		for (const s of body) {
			if (acc >= 4 && acc + s.tokens <= discardEnd) {
				dropped++;
				removed.push(s);
			} else if (acc < discardEnd && acc + s.tokens > 4) removed.push({ ...s, head: `(partly) ${s.head ?? ""}` });
			acc += s.tokens;
		}
		return { processed: limit, dropped, removed };
	}
	let total = rendered.tokens;
	let dropped = 0;
	// Keep the leading prefix/tools/system segments and the tail; drop the oldest messages.
	const first = body.findIndex((s) => s.role === "user" || s.role === "assistant" || s.role === "tool");
	for (let i = Math.max(0, first); i < body.length - 2 && total > limit; i++) {
		total -= body[i].tokens;
		dropped++;
		removed.push(body[i]);
	}
	return { processed: total, dropped, removed };
}

export function installProviderSim(harness: Harness, options: SimOptions): ProviderSim {
	const sim: ProviderSim = { calls: [], tokenizer: options.tokenizer };
	// Answer timestamps strictly increase, so each one identifies its request (C8 matches named answers by it).
	let lastAnswerAt = 0;
	const agent = harness.session.agent;
	const original = agent.streamFunction;
	const errorStream = (model: Model<string>, errorMessage: string) => {
		const stream = createAssistantMessageEventStream();
		const error = fauxAssistantMessage([], { stopReason: "error", errorMessage });
		error.provider = model.provider;
		error.model = model.id;
		error.api = model.api;
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "error", error });
			stream.end(error);
		});
		return stream;
	};
	const outputTokens = (message: AssistantMessage): number => {
		let tokens = 0;
		for (const block of message.content) {
			if (block.type === "text") tokens += options.counter.count(block.text);
			else if (block.type === "thinking") tokens += options.counter.count(block.thinking);
			else if (block.type === "toolCall")
				tokens += options.counter.count(`${block.name}${JSON.stringify(block.arguments)}`) + 3;
		}
		return tokens;
	};
	agent.streamFunction = async (model, context, streamOptions) => {
		const index = sim.calls.length;
		const providerMax = clampMaxTokensToContext(model, context, streamOptions?.maxTokens ?? model.maxTokens);
		let payload: Record<string, unknown> = {
			model: model.id,
			max_tokens: providerMax,
			messages: context.messages.length,
		};
		if (streamOptions?.onPayload) {
			const replaced = await streamOptions.onPayload(payload, model);
			if (replaced !== undefined) payload = replaced as Record<string, unknown>;
		}
		const rendered = renderRequest(
			context as TranscriptContext,
			options.tokenizer,
			options.counter,
			options.noticeMarker,
		);
		const body = rendered.segments.filter((s) => !s.tail);
		const call: SimCall = {
			index,
			input: rendered.tokens,
			processed: rendered.tokens,
			limit: options.limit,
			rejected: false,
			truncated: false,
			truncatedTokens: 0,
			droppedSegments: 0,
			images: rendered.images,
			imageTokens: rendered.imageTokens,
			segments: rendered.segments.length,
			keys: body.map((s) => s.key),
			noticeTail: body.at(-1)?.notice === true,
			maxTokens: payload.max_tokens as number | undefined,
		};
		sim.calls.push(call);
		options.observe?.(call);
		if (rendered.tokens > options.limit) {
			if (options.mode === "reject") {
				call.rejected = true;
				call.errorText = overflowError(options.errorStyle, rendered.tokens, options.limit, index);
				return errorStream(model, call.errorText);
			}
			const { processed, dropped, removed } = truncate(rendered, options.limit, options.truncation ?? "front");
			options.onTruncate?.(index, removed);
			call.truncated = true;
			call.processed = processed;
			call.truncatedTokens = rendered.tokens - processed;
			call.droppedSegments = dropped;
		}
		// The faux provider produces the scripted answer; its content does not depend on what was dropped.
		const inner = await original(model, context, streamOptions);
		const outer = createAssistantMessageEventStream();
		const finish = (message: AssistantMessage): AssistantMessage => {
			const output = message.stopReason === "error" ? 0 : outputTokens(message);
			call.output = output;
			const timestamp = Math.max(message.timestamp, lastAnswerAt + 1);
			lastAnswerAt = timestamp;
			call.answerAt = timestamp;
			return {
				...message,
				timestamp,
				usage: {
					...message.usage,
					input: call.processed,
					output,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: call.processed + output,
				},
			};
		};
		(async () => {
			for await (const event of inner) {
				if (event.type === "done") {
					const message = finish(event.message);
					outer.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
					outer.end(message);
					return;
				}
				if (event.type === "error") {
					const error = finish(event.error);
					outer.push({ ...event, error });
					outer.end(error);
					return;
				}
				outer.push(event);
			}
			outer.end(await inner.result());
		})();
		return outer;
	};
	return sim;
}
