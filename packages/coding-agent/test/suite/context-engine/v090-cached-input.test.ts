/**
 * 0.9.0 (design section 5, review's caution 2): cached input, per pi-ai provider mapping. The detector reads a request's
 * reported size as `input + cacheRead + cacheWrite` (detector.ts). Each provider reports cached input its own way: some
 * count it inside the prompt total (OpenAI, Gemini, Mistral), some beside it (Anthropic, Bedrock). For every mapping, a
 * request with a cache hit, and with a cache write where the provider has one, must give the same sum as the same
 * request with no cache: nothing counted twice, nothing dropped. Each provider's stream runs on a fake transport with
 * the usage its API returns.
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	openaiUsage: undefined as Record<string, unknown> | undefined,
	googleUsage: undefined as Record<string, unknown> | undefined,
	bedrockUsage: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
							yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: mocks.openaiUsage };
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "r",
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: mocks.googleUsage,
				};
			},
		};
	}
	return {
		GoogleGenAI,
		FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS", SAFETY: "SAFETY" },
		FunctionCallingConfigMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE" },
		ThinkingLevel: {},
	};
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };
		send(): Promise<unknown> {
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } };
					yield { contentBlockStop: { contentBlockIndex: 0 } };
					yield { messageStop: { stopReason: "end_turn" } };
					yield { metadata: { usage: mocks.bedrockUsage } };
				})(),
			});
		}
	}
	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamAnthropic } from "../../../../ai/src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../../../../ai/src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../../../../ai/src/api/google-generative-ai.ts";
import { stream as streamMistral } from "../../../../ai/src/api/mistral-conversations.ts";
import { stream as streamOpenAICompletions } from "../../../../ai/src/api/openai-completions.ts";
import { processResponsesStream } from "../../../../ai/src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../../../../ai/src/compat.ts";
import type { AssistantMessage, FetchFunction } from "../../../../ai/src/types.ts";
import { createAssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";

/** The sum the detector reads (detector.ts calibrate). */
const reported = (usage: AssistantMessage["usage"]) => usage.input + usage.cacheRead + usage.cacheWrite;

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const TOTAL = 1_000;

function sse(events: Array<{ event?: string; data: unknown }>, crlf = false): Response {
	const sep = crlf ? "\r\n" : "\n";
	const body = events
		.map((e) => `${e.event ? `event: ${e.event}${sep}` : ""}data: ${JSON.stringify(e.data)}${sep}`)
		.join(sep);
	return new Response(`${body}${sep}`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function anthropic(usage: Record<string, number>): Promise<AssistantMessage> {
	const response = sse([
		{
			event: "message_start",
			data: { type: "message_start", message: { id: "m", usage: { ...usage, output_tokens: 0 } } },
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { ...usage, output_tokens: 2 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
	const client = {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as NonNullable<Parameters<typeof streamAnthropic>[2]>["client"];
	return streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, { client }).result();
}

async function openaiCompletions(usage: Record<string, unknown>): Promise<AssistantMessage> {
	mocks.openaiUsage = { completion_tokens: 2, ...usage };
	// The catalogue types gpt-4o-mini for the responses API; the test needs only the completions stream's usage mapping.
	const model = getModel("openai", "gpt-4o-mini") as unknown as Parameters<typeof streamOpenAICompletions>[0];
	return streamOpenAICompletions(model, context, { apiKey: "k" }).result();
}

async function openaiResponses(usage: Record<string, unknown>): Promise<AssistantMessage> {
	const model = getModel("openai", "gpt-4o-mini");
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const events = (async function* () {
		yield { type: "response.completed", response: { id: "r", output: [], usage: { output_tokens: 2, ...usage } } };
	})();
	await processResponsesStream(events as never, output, createAssistantMessageEventStream(), model);
	return output;
}

async function google(usage: Record<string, unknown>): Promise<AssistantMessage> {
	mocks.googleUsage = { candidatesTokenCount: 2, ...usage };
	return streamGoogle(getModel("google", "gemini-2.5-flash"), context, { apiKey: "k" }).result();
}

async function bedrock(usage: Record<string, unknown>): Promise<AssistantMessage> {
	mocks.bedrockUsage = { outputTokens: 2, ...usage };
	return streamBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
		cacheRetention: "none",
	}).result();
}

async function mistral(usage: Record<string, unknown>): Promise<AssistantMessage> {
	const fetch: FetchFunction = async () =>
		sse(
			[
				{ data: { id: "r", model: "mistral-large-latest", choices: [{ index: 0, delta: { content: "ok" } }] } },
				{
					data: {
						id: "r",
						model: "mistral-large-latest",
						choices: [{ index: 0, finish_reason: "stop", delta: {} }],
						usage: { completion_tokens: 2, ...usage },
					},
				},
			],
			true,
		);
	return streamMistral(getModel("mistral", "mistral-large-latest"), context, { apiKey: "k", fetch }).result();
}

describe("0.9.0: cached input, per provider mapping: the detector's sum is the request's whole size", () => {
	it("Anthropic: cache reads and writes are beside input_tokens", async () => {
		const none = await anthropic({ input_tokens: TOTAL, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
		const hit = await anthropic({
			input_tokens: 100,
			cache_read_input_tokens: 800,
			cache_creation_input_tokens: 100,
		});
		expect(reported(none.usage)).toBe(TOTAL);
		expect(reported(hit.usage)).toBe(TOTAL);
	});

	it("OpenAI chat completions: cached_tokens is inside prompt_tokens", async () => {
		const none = await openaiCompletions({ prompt_tokens: TOTAL, prompt_tokens_details: { cached_tokens: 0 } });
		const hit = await openaiCompletions({ prompt_tokens: TOTAL, prompt_tokens_details: { cached_tokens: 800 } });
		expect(reported(none.usage)).toBe(TOTAL);
		expect(reported(hit.usage)).toBe(TOTAL);
		expect(hit.usage.cacheRead).toBe(800);
	});

	it("OpenAI chat completions, DeepSeek's field: prompt_cache_hit_tokens is inside prompt_tokens", async () => {
		const hit = await openaiCompletions({ prompt_tokens: TOTAL, prompt_cache_hit_tokens: 600 });
		expect(reported(hit.usage)).toBe(TOTAL);
	});

	it("OpenAI responses: cached and cache-write tokens are inside input_tokens", async () => {
		const none = await openaiResponses({ input_tokens: TOTAL, input_tokens_details: { cached_tokens: 0 } });
		const hit = await openaiResponses({
			input_tokens: TOTAL,
			input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
		});
		expect(reported(none.usage)).toBe(TOTAL);
		expect(reported(hit.usage)).toBe(TOTAL);
	});

	it("Gemini: cachedContentTokenCount is inside promptTokenCount", async () => {
		const none = await google({ promptTokenCount: TOTAL });
		const hit = await google({ promptTokenCount: TOTAL, cachedContentTokenCount: 900 });
		expect(reported(none.usage)).toBe(TOTAL);
		expect(reported(hit.usage)).toBe(TOTAL);
	});

	it("Bedrock: cache reads and writes are beside inputTokens", async () => {
		const none = await bedrock({ inputTokens: TOTAL });
		const hit = await bedrock({ inputTokens: 100, cacheReadInputTokens: 800, cacheWriteInputTokens: 100 });
		expect(reported(none.usage)).toBe(TOTAL);
		expect(reported(hit.usage)).toBe(TOTAL);
	});

	it("Mistral: cached_tokens is inside prompt_tokens", async () => {
		const none = await mistral({ prompt_tokens: TOTAL });
		const hit = await mistral({ prompt_tokens: TOTAL, prompt_tokens_details: { cached_tokens: 800 } });
		expect(reported(none.usage)).toBe(TOTAL);
		expect(reported(hit.usage)).toBe(TOTAL);
	});
});
