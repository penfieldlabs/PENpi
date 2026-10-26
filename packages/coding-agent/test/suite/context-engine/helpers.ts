/**
 * Test helpers for the context engine suite: a synthetic workload tool, a scripted faux model that
 * records every request, prefix-stability analysis, and a provider simulator (token scale, hard
 * input limit, payload hook) wrapped around the faux stream function.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { Harness } from "../harness.ts";

/** Reports and logs the tests write: this directory's git-ignored .cache/ (CONTEXT_ENGINE_OUT moves it). */
export const LOG_DIR = process.env.CONTEXT_ENGINE_OUT ?? fileURLToPath(new URL("./.cache/out", import.meta.url));
mkdirSync(LOG_DIR, { recursive: true });

export function logger(file: string): (line: string) => void {
	const path = join(LOG_DIR, file);
	return (line: string) => appendFileSync(path, `${line}\n`);
}

/** Deterministic pseudo-random generator. */
export function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const WORDS =
	"alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega vector buffer parse token cache window frame index".split(
		" ",
	);

export function syntheticText(size: number, seed: number): string {
	const next = rng(seed);
	const lines: string[] = [];
	let length = 0;
	let line = 0;
	while (length < size) {
		const words = Array.from({ length: 8 }, () => WORDS[Math.floor(next() * WORDS.length)]).join(" ");
		const text = `${seed}:${line++} ${words}`;
		lines.push(text);
		length += text.length + 1;
	}
	return lines.join("\n").slice(0, size);
}

/** Registers `work`, a tool whose output size is chosen by the model's arguments. */
export function workExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "work",
		label: "work",
		description: "Do a unit of synthetic work and return its output.",
		parameters: Type.Object({ size: Type.Number(), seed: Type.Number(), path: Type.Optional(Type.String()) }),
		execute: async (_id, { size, seed }) => ({
			content: [{ type: "text", text: syntheticText(size, seed) }],
			details: {},
		}),
	});
}

// ---------------------------------------------------------------- scripted model

export type ScriptItem = (context: TranscriptContext) => AssistantMessage;

export interface ScriptedModel {
	/** Every request that reached the model, serialized per message (what the provider would see). */
	requests: string[][];
	/** Provider-side prompt tokens of each recorded request (faux accounting: chars / 4). */
	promptTokens: number[];
	cursor: number;
	push(...items: ScriptItem[]): void;
	remaining(): number;
}

/** Fields of a message the provider actually receives; timestamps and accounting are local. */
export function serializeForProvider(message: Message): string {
	const {
		timestamp: _t,
		usage: _u,
		api: _a,
		provider: _p,
		model: _m,
		stopReason: _s,
		responseId: _r,
		thinkingLevel: _l,
		errorMessage: _e,
		details: _d,
		nestedCalls: _n,
		durationMs: _du,
		...rest
	} = message as unknown as Record<string, unknown>;
	return JSON.stringify(rest);
}

/** Faux provider prompt text length (mirrors packages/ai/src/providers/faux.ts). */
export function fauxPromptChars(context: TranscriptContext): number {
	const text = (message: Message): string => {
		if (message.role === "system") {
			return [
				getSystemMessageText(message),
				...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
				...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
			]
				.filter((part) => part.length > 0)
				.join("\n");
		}
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		if (message.role === "toolResult") {
			return [
				message.toolName,
				...blocks.map((b) =>
					b.type === "text"
						? (b as { text: string }).text
						: `[image:${(b as { mimeType: string }).mimeType}:${(b as { data: string }).data.length}]`,
				),
			].join("\n");
		}
		return (
			blocks as Array<{
				type: string;
				text?: string;
				thinking?: string;
				name?: string;
				arguments?: unknown;
				mimeType?: string;
				data?: string;
			}>
		)
			.map((b) =>
				b.type === "text"
					? (b.text ?? "")
					: b.type === "thinking"
						? (b.thinking ?? "")
						: b.type === "toolCall"
							? `${b.name}:${JSON.stringify(b.arguments)}`
							: `[image:${b.mimeType}:${b.data?.length}]`,
			)
			.join("\n");
	};
	const parts = context.messages.map((m) => `${m.role}:${text(m)}`);
	return parts.reduce((sum, p) => sum + p.length, 0) + Math.max(0, parts.length - 1) * 2;
}

const digestCache = new WeakMap<object, string>();

/** "<chars>#<sha1>[#notice]": a compact stand-in for a serialized message (long sessions). */
function digestOf(message: Message): string {
	const cached = digestCache.get(message);
	if (cached) return cached;
	const text = serializeForProvider(message);
	const digest = `${text.length}#${createHash("sha1").update(text).digest("hex")}${text.includes("[context-engine notice]") ? "#notice" : ""}`;
	digestCache.set(message, digest);
	return digest;
}

export function scriptedModel(harness: Harness, capacity = 4000, options: { digest?: boolean } = {}): ScriptedModel {
	const items: ScriptItem[] = [];
	const model: ScriptedModel = {
		requests: [],
		promptTokens: [],
		cursor: 0,
		push: (...more) => items.push(...more),
		remaining: () => items.length - model.cursor,
	};
	const dispatcher = (context: TranscriptContext) => {
		model.requests.push(context.messages.map(options.digest ? digestOf : serializeForProvider));
		model.promptTokens.push(Math.ceil(fauxPromptChars(context) / 4));
		const item = items[model.cursor++];
		if (!item) return fauxAssistantMessage("(script exhausted)");
		return item(context);
	};
	harness.setResponses(Array.from({ length: capacity }, () => dispatcher));
	return model;
}

export function toolTurn(size: number, seed: number, note = ""): ScriptItem {
	return () =>
		fauxAssistantMessage(
			[fauxText(`Step ${seed}. ${note}`), fauxToolCall("work", { size, seed }, { id: `call-${seed}` })],
			{
				stopReason: "toolUse",
			},
		);
}

export function finalTurn(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): ScriptItem {
	return () => fauxAssistantMessage(text, { stopReason });
}

// ---------------------------------------------------------------- prefix analysis

export interface PrefixReport {
	requests: number;
	appendOnly: number;
	breaks: number;
	breakAt: number[];
	distinctHeads: number;
	/**
	 * Share of all request characters (serialized messages, not billed tokens) that an ideal prefix
	 * cache would have served: the common message prefix with the previous request.
	 */
	idealPrefixShare: number;
}

/**
 * For consecutive requests, count how many extend the previous request message-for-message
 * (prefix-stable) and how many rewrite it. `isRequestOnlyTail` marks a trailing message that is
 * never persisted (the engine's pre-cut notice); it is removed from the previous request before
 * comparing, because the next request cannot contain it.
 */
/** Characters of a serialized message, or of the message a digest stands for. */
function charLength(message: string): number {
	const digest = message.match(/^(\d+)#[0-9a-f]{40}(#notice)?$/);
	return digest ? Number(digest[1]) : message.length;
}

export function analyzePrefixes(requests: string[][], isRequestOnlyTail?: (message: string) => boolean): PrefixReport {
	let appendOnly = 0;
	let breaks = 0;
	const breakAt: number[] = [];
	let cached = 0;
	let total = 0;
	const heads = new Set<string>();
	for (let i = 0; i < requests.length; i++) {
		const current = requests[i];
		total += current.reduce((sum, m) => sum + charLength(m), 0);
		heads.add(current.slice(0, 2).join("\u0000"));
		if (i === 0) continue;
		let previous = requests[i - 1];
		const last = previous.at(-1);
		if (isRequestOnlyTail && last !== undefined && isRequestOnlyTail(last)) previous = previous.slice(0, -1);
		let common = 0;
		while (common < previous.length && common < current.length && previous[common] === current[common]) common++;
		cached += current.slice(0, common).reduce((sum, m) => sum + charLength(m), 0);
		if (common === previous.length) appendOnly++;
		else {
			breaks++;
			breakAt.push(i);
		}
	}
	return {
		requests: requests.length,
		appendOnly,
		breaks,
		breakAt,
		distinctHeads: heads.size,
		idealPrefixShare: total ? cached / total : 0,
	};
}

/**
 * Port: /reload in a test. AgentSession.reload() resets Pi's API providers (resetApiProviders), which drops
 * the harness's faux provider, so the next request failed with "No API provider registered" and a test
 * comparing requests after the reload compared the last one from before it. This reloads and registers the
 * faux provider again.
 */
export async function reloadKeepingFaux(harness: Harness): Promise<void> {
	const faux = getApiProvider(harness.faux.api as never);
	if (!faux) throw new Error(`no API provider registered for ${harness.faux.api}`);
	await harness.session.reload();
	if (!getApiProvider(harness.faux.api as never)) registerApiProvider(faux as never);
}

// ---------------------------------------------------------------- provider simulator

export interface SimCall {
	/** D25: the request's abort signal had already fired when it reached the provider (a real one sends nothing). */
	aborted?: boolean;
	/** Provider-side prompt tokens of the request as sent. */
	promptTokens: number;
	/** Prompt tokens the provider actually processed (lower when it silently truncated). */
	processedTokens: number;
	maxTokens: number | undefined;
	rejected: boolean;
	truncatedInput: boolean;
	droppedMessages: number;
	outputTokens?: number;
	lengthStop?: boolean;
	payload: Record<string, unknown>;
	model: string;
}

export interface ProviderSim {
	calls: SimCall[];
}

export interface SimOptions {
	/** Provider tokens per faux token (chars / 4); a number or per model. */
	scale?: number | ((model: Model<string>) => number);
	/** Reject requests above this many provider tokens (number, or per call). */
	realLimit?: number | ((callIndex: number, promptTokens: number, model: Model<string>) => number | undefined);
	/** Overflow error text. Default: Anthropic style. */
	overflowMessage?: (promptTokens: number, limit: number) => string;
	/** Silently drop the oldest non-system messages until the prompt fits, keep the tail, report the truncated usage. */
	silentLimit?: number;
	/**
	 * Round 5: what a silently truncating server reports. "limit" (default): exactly the limit (a server
	 * that fills its context, Ollama-style). "remainder": the real count of what it kept (a server that
	 * drops whole old messages).
	 */
	silentReport?: "limit" | "remainder";
	/** Cut the response at the payload's max_tokens (and at outputCeiling) with stopReason "length". */
	honorMaxTokens?: boolean;
	/** The provider's real output limit, whatever the payload asks for. */
	outputCeiling?: number;
	/** Provider-side cost of one image block. Default: what faux counts (its placeholder text). */
	imageTokens?: (image: { data: string; mimeType: string }) => number;
	/** Add an Anthropic-style thinking budget to the synthetic payload. */
	thinkingBudget?: number;
	/** A provider that ignores the reasoning Pi replays: earlier assistants' thinking blocks are not counted. */
	ignoreReplayedReasoning?: boolean;
	/**
	 * A provider that counts this share of the replayed reasoning (0 to 1; ignoreReplayedReasoning is 0), or a
	 * share per assistant message (its index among the request's assistant messages).
	 */
	replayedReasoningShare?: number | ((assistant: number) => number);
	/**
	 * D24: a router in front of several upstream providers (OpenRouter). Per call, the provider serving it: its
	 * name, sent as the stream's `provider` field (provider_stream_event, as Pi's SDK forwards raw chunks; none
	 * when undefined), how it counts the request against the faux count (scale), and, when set, that it silently
	 * keeps only that many tokens and reports exactly that (holds). The name is sent before a rejection: a stream
	 * can name its provider and then fail.
	 */
	servedBy?: (callIndex: number) => {
		name?: string;
		scale?: number;
		holds?: number;
		/** That provider silently drops the oldest messages above this many tokens and reports what it kept. */
		drops?: number;
		/** That provider reports this many tokens fewer than it processed (a count that falls short). */
		offset?: number;
	};
	/**
	 * D24 R1: the provider counts the text of an answer that stopped at the output limit at this share (what a
	 * provider counts of a cut answer is provider-specific).
	 */
	cutAnswerShare?: number;
	/** Round 4: reject a request with this error text (output limits, combined errors, ...). */
	reject?: (request: {
		index: number;
		promptTokens: number;
		maxTokens: number | undefined;
		model: Model<string>;
	}) => string | undefined;
}

function imagesIn(context: TranscriptContext): Array<{ data: string; mimeType: string }> {
	const images: Array<{ data: string; mimeType: string }> = [];
	for (const message of context.messages) {
		if (message.role === "system" || typeof message.content === "string") continue;
		for (const block of message.content as Array<{ type: string; data?: string; mimeType?: string }>) {
			if (block.type === "image" && block.data && block.mimeType)
				images.push({ data: block.data, mimeType: block.mimeType });
		}
	}
	return images;
}

/** Width and height from a base64 PNG or JPEG header. */
export function imageSize(data: string): { width: number; height: number } | undefined {
	const bytes = Buffer.from(data.slice(0, 64_000), "base64");
	if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47)
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let i = 2;
		while (i + 9 < bytes.length) {
			if (bytes[i] !== 0xff) return undefined;
			const marker = bytes[i + 1];
			const length = bytes.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
			}
			i += 2 + length;
		}
	}
	return undefined;
}

/** Anthropic's published image cost: width x height / 750, at most about 1,600 tokens after its resize. */
export function anthropicImageTokens(image: { data: string }): number {
	const size = imageSize(image.data);
	return size ? Math.min(1_600, Math.ceil((size.width * size.height) / 750)) : 1_600;
}

/**
 * Wrap the session's stream function so it behaves like a provider: count prompt tokens with a
 * tokenizer that yields `scale` x the faux count (plus image costs), reject or silently truncate
 * oversized requests, call `onPayload` with a synthetic payload and honor its max_tokens, and report
 * provider-side usage.
 */
export function installProviderSim(harness: Harness, options: SimOptions = {}): ProviderSim {
	const sim: ProviderSim = { calls: [] };
	const agent = harness.session.agent;
	const original = agent.streamFunction;
	const scaleFor = (model: Model<string>) =>
		typeof options.scale === "function" ? options.scale(model) : (options.scale ?? 1);
	const replayShare = options.ignoreReplayedReasoning ? 0 : options.replayedReasoningShare;
	const withoutReplay = (
		context: TranscriptContext,
		replay: number | ((assistant: number) => number),
	): TranscriptContext => {
		let assistant = 0;
		return {
			...context,
			messages: context.messages.map((m) => {
				if (m.role !== "assistant") return m;
				const share = typeof replay === "function" ? replay(assistant++) : replay;
				return {
					...m,
					content: m.content.flatMap((b): AssistantMessage["content"] =>
						b.type !== "thinking"
							? [b]
							: share > 0
								? [{ ...b, thinking: b.thinking.slice(0, Math.floor(b.thinking.length * share)) }]
								: [],
					),
				};
			}),
		};
	};
	const cutAnswers = (context: TranscriptContext, share: number): TranscriptContext => ({
		...context,
		messages: context.messages.map((m) =>
			m.role !== "assistant" || m.stopReason !== "length"
				? m
				: {
						...m,
						content: m.content.map((b) =>
							b.type === "text" ? { ...b, text: b.text.slice(0, Math.floor(b.text.length * share)) } : b,
						),
					},
		),
	});
	const count = (full: TranscriptContext, model: Model<string>) => {
		const replayed = replayShare !== undefined ? withoutReplay(full, replayShare) : full;
		const context = options.cutAnswerShare !== undefined ? cutAnswers(replayed, options.cutAnswerShare) : replayed;
		const images = imagesIn(context);
		const imageCost = options.imageTokens ? images.reduce((sum, image) => sum + options.imageTokens!(image), 0) : 0;
		return Math.ceil((fauxPromptChars(context) / 4) * scaleFor(model)) + imageCost;
	};
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
	agent.streamFunction = async (model, context, streamOptions) => {
		const index = sim.calls.length;
		// What built-in providers put in the payload (packages/ai/src/api/simple-options.ts buildBaseOptions).
		const providerMax = clampMaxTokensToContext(model, context, streamOptions?.maxTokens ?? model.maxTokens);
		let payload: Record<string, unknown> = {
			model: model.id,
			max_tokens: providerMax,
			messages: context.messages.length,
		};
		if (options.thinkingBudget) payload.thinking = { type: "enabled", budget_tokens: options.thinkingBudget };
		if (streamOptions?.onPayload) {
			const replaced = await streamOptions.onPayload(payload, model);
			if (replaced !== undefined) payload = replaced as Record<string, unknown>;
		}
		const promptTokens = count(context, model);
		const maxTokens = payload.max_tokens as number | undefined;
		const limit =
			typeof options.realLimit === "function" ? options.realLimit(index, promptTokens, model) : options.realLimit;
		const call: SimCall = {
			promptTokens,
			processedTokens: promptTokens,
			maxTokens,
			rejected: false,
			truncatedInput: false,
			droppedMessages: 0,
			payload,
			model: model.id,
			...(streamOptions?.signal?.aborted ? { aborted: true } : {}),
		};
		sim.calls.push(call);
		const served = options.servedBy?.(index);
		if (served?.name)
			await harness.session.extensionRunner.emit({
				type: "provider_stream_event",
				provider: model.provider,
				api: model.api,
				model: model.id,
				data: { id: `gen-${index}`, provider: served.name, model: model.id },
			});
		if (limit !== undefined && promptTokens > limit) {
			call.rejected = true;
			const text =
				options.overflowMessage?.(promptTokens, limit) ??
				`prompt is too long: ${promptTokens} tokens > ${limit} maximum`;
			return errorStream(model, text);
		}
		const rejection = options.reject?.({ index, promptTokens, maxTokens, model });
		if (rejection !== undefined) {
			call.rejected = true;
			return errorStream(model, rejection);
		}
		let sentContext = context;
		const silentLimit = served?.drops ?? options.silentLimit;
		const silentReport = served?.drops !== undefined ? "remainder" : options.silentReport;
		if (silentLimit !== undefined && promptTokens > silentLimit) {
			const messages = [...context.messages];
			const firstBody = messages.findIndex((m) => m.role !== "system");
			while (count({ ...context, messages }, model) > silentLimit && messages.length - firstBody > 1) {
				messages.splice(firstBody, 1);
				call.droppedMessages++;
			}
			sentContext = { ...context, messages };
			call.truncatedInput = true;
			// A server that fills its context window reports exactly that many prompt tokens.
			call.processedTokens = silentReport === "remainder" ? count({ ...context, messages }, model) : silentLimit;
		}
		if (served?.scale !== undefined) call.processedTokens = Math.ceil(call.processedTokens * served.scale);
		if (served?.offset !== undefined) call.processedTokens -= served.offset;
		if (served?.holds !== undefined && call.processedTokens > served.holds) {
			call.truncatedInput = true;
			call.processedTokens = served.holds;
		}
		const inner = await original(model, sentContext, streamOptions);
		const outer = createAssistantMessageEventStream();
		const outputCap = Math.min(
			options.honorMaxTokens && maxTokens !== undefined && maxTokens > 0 ? maxTokens : Number.POSITIVE_INFINITY,
			options.outputCeiling ?? Number.POSITIVE_INFINITY,
		);
		const finish = (message: AssistantMessage): AssistantMessage => {
			let next: AssistantMessage = {
				...message,
				usage: { ...message.usage, input: call.processedTokens, cacheRead: 0, cacheWrite: 0 },
			};
			if (message.stopReason !== "error" && message.stopReason !== "aborted" && message.usage.output > outputCap) {
				let room = outputCap * 4;
				const content = message.content.map((block) => {
					if (block.type !== "text") return block;
					const text = block.text.slice(0, Math.max(0, room));
					room -= text.length;
					return { ...block, text };
				});
				next = { ...next, content, stopReason: "length", usage: { ...next.usage, output: outputCap } };
				call.lengthStop = true;
			}
			next.usage.totalTokens = next.usage.input + next.usage.output;
			call.outputTokens = next.usage.output;
			return next;
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

export function countEntries(harness: Harness): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of harness.sessionManager.getEntries()) {
		const key = entry.type === "custom" ? `custom:${entry.customType}` : entry.type;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/**
 * Structural checks a strict provider (Anthropic Messages) would enforce: the conversation starts with
 * a user message, every tool result answers a tool call earlier in the same request, and every tool
 * call is answered. Returns one string per violation.
 */
export function validateRequest(messages: string[]): string[] {
	const parsed = messages.map((m) => JSON.parse(m) as { role: string; content?: unknown; toolCallId?: string });
	const problems: string[] = [];
	const firstNonSystem = parsed.find((m) => m.role !== "system");
	if (firstNonSystem && firstNonSystem.role !== "user") problems.push(`starts with ${firstNonSystem.role}`);
	const calls = new Set<string>();
	const answered = new Set<string>();
	for (const message of parsed) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as Array<{ type: string; id?: string }>)
				if (block.type === "toolCall" && block.id) calls.add(block.id);
		}
		if (message.role === "toolResult" && message.toolCallId) {
			if (!calls.has(message.toolCallId)) problems.push(`orphan result ${message.toolCallId}`);
			answered.add(message.toolCallId);
		}
	}
	for (const id of calls) if (!answered.has(id)) problems.push(`unanswered call ${id}`);
	return problems;
}

// ---------------------------------------------------------------- round 2 helpers

/** Registers `blob`, a tool that returns preset text and images by name. */
export function blobExtension(
	blobs: Record<string, { text?: string; images?: Array<{ data: string; mimeType: string }> }>,
) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "blob",
			label: "blob",
			description: "Return a preset blob.",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (_id, { name }) => {
				const blob = blobs[name];
				if (!blob) throw new Error(`no blob ${name}`);
				return {
					content: [
						...(blob.text !== undefined ? [{ type: "text" as const, text: blob.text }] : []),
						...(blob.images ?? []).map((image) => ({ type: "image" as const, ...image })),
					],
					details: {},
				};
			},
		});
	};
}

/** Registers `write_file`, which records every successful write. */
export function writeFileExtension(writes: Array<{ path: string; chars: number }>) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "write_file",
			label: "write_file",
			description: "Write a file.",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async (_id, { path, content }) => {
				writes.push({ path, chars: content.length });
				return { content: [{ type: "text", text: `wrote ${content.length} chars to ${path}` }], details: {} };
			},
		});
	};
}

/** Push `prompts` prompts of `turns` assistant turns each (turns-1 tool calls + a final answer) and run them. */
export async function runPrompts(
	harness: Harness,
	model: ScriptedModel,
	options: {
		prompts: number;
		turns: number;
		seed?: number;
		min?: number;
		spread?: number;
		prompt?: (p: number) => string;
		seedBase?: number;
	},
): Promise<void> {
	const next = rng(options.seed ?? 7);
	let seed = options.seedBase ?? 0;
	for (let p = 0; p < options.prompts; p++) {
		for (let t = 0; t < options.turns - 1; t++) {
			model.push(toolTurn((options.min ?? 1_000) + Math.floor(next() * (options.spread ?? 4_000)), seed++));
		}
		model.push(finalTurn(`done ${p}`));
		await harness.session.prompt(options.prompt?.(p) ?? `Task ${p}`);
	}
}

/** Merge `data` into LOG_DIR/reports/<file>.<engine>.json. */
export function report(file: string, engine: string, key: string, data: unknown): void {
	const dir = join(LOG_DIR, "reports");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${file}.${engine}.json`);
	let current: Record<string, unknown> = {};
	try {
		current = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	current[key] = data;
	writeFileSync(path, JSON.stringify(current, null, 2));
}

// ---------------------------------------------------------------- round 4 helpers

export interface CacheModelResult {
	/** Request tokens over the session (chars / 4 of what each request carried). */
	total: number;
	/** Served from an earlier cache entry. */
	read: number;
	/** Processed and written at this request's breakpoint. */
	written: number;
	/** After the breakpoint (the notice, when the surgery moved the breakpoint before it). */
	tail: number;
	/** Share of request tokens not served from cache: (written + tail) / total. */
	missShare: number;
}

/**
 * G3: a model of Anthropic prompt caching as Pi's payload drives it. Breakpoints sit on the system
 * prompt and on the last block of the request; with `surgery`, a trailing request-only notice is
 * skipped and the breakpoint goes on the message before it. A request reads the longest earlier entry
 * that is a prefix of it, looking back at most 20 blocks (approximated as messages) from its
 * breakpoint, and writes an entry at its breakpoint. Entries never expire (a continuous session).
 */
export function anthropicCacheModel(
	requests: string[][],
	isNotice: (message: string) => boolean,
	surgery: boolean,
): CacheModelResult {
	const entries = new Set<string>();
	const tokens = (m: string) => charLength(m) / 4;
	let total = 0;
	let read = 0;
	let written = 0;
	let tail = 0;
	for (const messages of requests) {
		const keys: string[] = [];
		let key = "";
		for (const m of messages) {
			key = createHash("sha1").update(key).update("\u0000").update(m).digest("hex");
			keys.push(key);
		}
		const sizes = messages.map(tokens);
		const sum = (from: number, to: number) => sizes.slice(from, to + 1).reduce((a, b) => a + b, 0);
		const last = messages.length - 1;
		const breakpoint = surgery && last > 0 && isNotice(messages[last]) ? last - 1 : last;
		let hit = -1;
		for (let j = breakpoint; j >= Math.max(0, breakpoint - 20); j--) {
			if (entries.has(keys[j])) {
				hit = j;
				break;
			}
		}
		if (hit < 0 && entries.has(keys[0])) hit = 0;
		total += sum(0, last);
		read += hit >= 0 ? sum(0, hit) : 0;
		written += sum(hit + 1, breakpoint);
		tail += sum(breakpoint + 1, last);
		entries.add(keys[0]);
		entries.add(keys[breakpoint]);
	}
	return { total, read, written, tail, missShare: total ? (written + tail) / total : 0 };
}
