/**
 * P3 (B1, B2; reviewer Change 2): the engine estimates what Pi actually serializes, per API, for the
 * budget and the silent-truncation detector. Checked against Pi's real converters: each scenario message
 * goes through streamSimple of openai-completions, anthropic-messages and bedrock-converse-stream; the
 * payload is captured in onPayload (nothing is sent: onPayload throws after capturing), and the engine's
 * serializedParts must agree on (1) whether the message is sent at all, (2) whether its reasoning is
 * sent. D4 (port): both are read from the real payload for every shape, blank ones included: the message
 * is sent when the payload with it differs from the payload without it, and its reasoning is sent when
 * the payload differs from the one with its reasoning (thinking blocks, tool-call thought signatures)
 * removed.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import { describe, expect, it } from "vitest";
import {
	messageTokens,
	type SerializeTarget,
	serializedParts,
	textTokens,
} from "../../../../../.pi/extensions/penpi/engine/index.ts";
import { report } from "./helpers.ts";

type Api = "openai-completions" | "anthropic-messages" | "bedrock-converse-stream";

const MODELS: Record<string, Model<Api>> = {
	openai: {
		id: "z-ai/glm-5.3-flash",
		name: "GLM",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	} as Model<Api>,
	openaiThinkingAsText: {
		id: "some/model",
		name: "thinking-as-text",
		api: "openai-completions",
		provider: "some-provider",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { requiresThinkingAsText: true },
	} as Model<Api>,
	anthropic: {
		id: "claude-sonnet-5-5",
		name: "Claude",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as Model<Api>,
	bedrock: {
		id: "anthropic.claude-sonnet-5-5-v1:0",
		name: "Claude on Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as Model<Api>,
};

const STREAMS = {
	"openai-completions": openaiStream,
	"anthropic-messages": anthropicStream,
	"bedrock-converse-stream": bedrockStream,
};

function targetOf(model: Model<Api>): SerializeTarget {
	return {
		api: model.api,
		provider: model.provider,
		modelId: model.id,
		thinkingAsText:
			(model as { compat?: { requiresThinkingAsText?: boolean } }).compat?.requiresThinkingAsText === true,
	};
}

/** The signature Pi stores for a thinking block from this API (what makes it replayable as reasoning). */
function signatureFor(model: Model<Api>, n: number): string {
	if (model.api === "openai-completions")
		return n % 2 === 0
			? JSON.stringify([{ type: "reasoning.text", text: `RSN-${n} reasoning`, format: "unknown", index: 0 }])
			: "reasoning_content";
	return `sig-${n}-${"A".repeat(40)}`;
}

type Case = {
	name: string;
	message: (model: Model<Api>, n: number) => Message;
	text?: boolean;
	reasoning?: boolean;
	/** The reasoning is carried only by a signature (no thinking text). */
	signatureOnly?: boolean;
};

/** The message without what it carries as reasoning: thinking blocks and tool-call thought signatures. */
function withoutReasoning(message: Message): Message {
	if (message.role !== "assistant") return message;
	return {
		...message,
		content: message.content
			.filter((b) => b.type !== "thinking")
			.map((b) => (b.type === "toolCall" ? { ...b, thoughtSignature: undefined } : b)),
	} as Message;
}

const REASONING = (n: number, size = 200) =>
	`RSN-${n} ${"we count the shipped orders by region; ".repeat(Math.ceil(size / 38))}`.slice(0, size);

function assistant(
	model: Model<Api>,
	content: AssistantMessage["content"],
	extra: Partial<AssistantMessage> = {},
): Message {
	return {
		role: "assistant",
		content,
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
		...extra,
	} as Message;
}

const CASES: Case[] = [
	{
		name: "reasoning only, length stop (the E4 B/s02 shape)",
		message: (m, n) =>
			assistant(m, [{ type: "thinking", thinking: REASONING(n, 4_000), thinkingSignature: signatureFor(m, n) }], {
				stopReason: "length",
			}),
	},
	{
		name: "reasoning (about 3,000 tokens) plus text (about 200 tokens)",
		message: (m, n) =>
			assistant(m, [
				{ type: "thinking", thinking: REASONING(n, 12_000), thinkingSignature: signatureFor(m, n) },
				{
					type: "text",
					text: `TXT-${n} ${"The most common type is order.shipped, then order.created. ".repeat(14)}`,
				},
			]),
	},
	{
		name: "reasoning without a signature plus text",
		message: (m, n) =>
			assistant(m, [
				{ type: "thinking", thinking: REASONING(n) },
				{ type: "text", text: `TXT-${n} answer` },
			]),
	},
	{
		name: "reasoning plus a tool call",
		message: (m, n) =>
			assistant(
				m,
				[
					{ type: "thinking", thinking: REASONING(n), thinkingSignature: signatureFor(m, n) },
					{ type: "toolCall", id: `call_${n}`, name: "bash", arguments: { command: `echo TXT-${n}` } },
				],
				{ stopReason: "toolUse" },
			),
	},
	{ name: "text only", message: (m, n) => assistant(m, [{ type: "text", text: `TXT-${n} plain answer` }]) },
	{ name: "blank text only", message: (m) => assistant(m, [{ type: "text", text: "   " }]) },
	{
		name: "errored, with text",
		message: (m, n) =>
			assistant(m, [{ type: "text", text: `TXT-${n} partial` }], { stopReason: "error", errorMessage: "boom" }),
	},
	{
		name: "aborted, with text",
		message: (m, n) => assistant(m, [{ type: "text", text: `TXT-${n} partial` }], { stopReason: "aborted" }),
	},
	{
		name: "from another model: reasoning only",
		message: (m, n) =>
			assistant(m, [{ type: "thinking", thinking: REASONING(n), thinkingSignature: "x" }], {
				provider: "other",
				model: "other-model",
				api: "other-api" as never,
			}),
	},
	{
		name: "user, blank text",
		message: () => ({ role: "user", content: [{ type: "text", text: "  " }], timestamp: 1 }) as Message,
	},
	// D4 (port): the shapes the engine under-counted.
	{ name: "user, blank string", message: () => ({ role: "user", content: "   ", timestamp: 1 }) as Message },
	{
		name: "empty thinking with a signature, plus text",
		signatureOnly: true,
		message: (m, n) =>
			assistant(m, [
				{ type: "thinking", thinking: "", thinkingSignature: signatureFor(m, n) },
				{ type: "text", text: `TXT-${n} answer` },
			]),
	},
	{
		name: "empty thinking with a signature, alone",
		signatureOnly: true,
		message: (m, n) => assistant(m, [{ type: "thinking", thinking: "", thinkingSignature: signatureFor(m, n) }]),
	},
	{
		name: "a tool call with a thoughtSignature (legacy encrypted reasoning)",
		signatureOnly: true,
		message: (m, n) =>
			assistant(
				m,
				[
					{
						type: "toolCall",
						id: `call_${n}`,
						name: "bash",
						arguments: { command: `echo TXT-${n}` },
						thoughtSignature: JSON.stringify({
							type: "reasoning.encrypted",
							id: `rs_${n}`,
							data: `RSN-${n}-${"e".repeat(400)}`,
							format: "unknown",
							index: 0,
						}),
					},
				],
				{ stopReason: "toolUse" },
			),
	},
	{
		name: "redacted thinking plus text",
		signatureOnly: true,
		message: (m, n) =>
			assistant(m, [
				{ type: "thinking", thinking: "", redacted: true, thinkingSignature: `UlNOLSR7bn0t${"QUFB".repeat(30)}` },
				{ type: "text", text: `TXT-${n} answer` },
			]),
	},
	{
		name: "user, text",
		message: (_m, n) =>
			({ role: "user", content: [{ type: "text", text: `TXT-${n} please` }], timestamp: 1 }) as Message,
	},
];

async function payloadOf(model: Model<Api>, messages: Message[]): Promise<string> {
	let captured: unknown;
	const stream = STREAMS[model.api](
		model as never,
		{ messages } as never,
		{
			apiKey: "test",
			onPayload: (p: unknown) => {
				captured = p;
				throw new Error("offline: payload captured");
			},
			fetch: async () => {
				throw new Error("offline");
			},
		} as never,
	);
	await stream.result();
	expect(captured, `${model.api}: payload captured`).toBeDefined();
	return JSON.stringify(captured);
}

describe("the serializer estimate matches Pi's real converters", () => {
	for (const [key, model] of Object.entries(MODELS)) {
		it(`${key} (${model.api}): sent / not sent and reasoning sent / not sent agree with the converter`, async () => {
			const rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < CASES.length; i++) {
				const n = 100 + i;
				const message = CASES[i].message(model, n);
				// A user turn first, so assistant messages are in a valid position.
				const opener = { role: "user", content: [{ type: "text", text: "OPEN please" }], timestamp: 1 } as Message;
				const without = await payloadOf(model, [opener]);
				const payload = await payloadOf(model, [opener, message]);
				const stripped = await payloadOf(model, [opener, withoutReasoning(message)]);
				const sent = payload !== without;
				const reasoningSent = payload !== stripped;
				const parts = serializedParts(message as never, targetOf(model));
				rows.push({ case: CASES[i].name, sent, reasoningSent, tokens: parts.tokens, reasoning: parts.reasoning });
				expect(parts.tokens > 0, `${key} ${CASES[i].name}: sent`).toBe(sent);
				// Reasoning the converter sends as reasoning (or as text when thinking-as-text) is the engine's reasoning;
				// reasoning from another model is sent as plain text and counted as text.
				const crossModel = CASES[i].name.startsWith("from another model");
				expect(parts.reasoning > 0, `${key} ${CASES[i].name}: reasoning`).toBe(reasoningSent && !crossModel);
				// The r5 estimate (messageTokens) bounds it, except where Pi sends more than the blocks' text: reasoning
				// carried only by a signature, and requiresThinkingAsText, which sends the thinking as text and its
				// reasoning_details as well.
				if (sent && !CASES[i].signatureOnly && !targetOf(model).thinkingAsText)
					expect(parts.tokens).toBeLessThanOrEqual(messageTokens(message as never));
				// A signature the converter sends bounds the estimate from below: what the signature adds to the
				// estimate (the message against the same message without its reasoning) is at least one token per 8
				// characters it adds to the request (half of chars / 4; signatures are base64, denser than that), so a
				// 400-character signature counted as a token or two fails. The request's growth is the payload's,
				// capped at the signature's own length: Bedrock's converter holds it as bytes, which the captured
				// payload's JSON spells as an index-keyed object, not as the base64 the wire carries.
				if (sent && reasoningSent && CASES[i].signatureOnly) {
					const signatureLength = [
						...JSON.stringify(message).matchAll(/"(?:thinkingSignature|thoughtSignature)":"((?:[^"\\]|\\.)*)"/g),
					].reduce((sum, m) => sum + m[1].length, 0);
					const signatureChars = Math.min(payload.length - stripped.length, signatureLength);
					const signatureTokens =
						parts.tokens - serializedParts(withoutReasoning(message) as never, targetOf(model)).tokens;
					expect(signatureChars, `${key} ${CASES[i].name}: signature in the request`).toBeGreaterThan(0);
					expect(signatureTokens, `${key} ${CASES[i].name}: lower bound`).toBeGreaterThanOrEqual(
						Math.floor(signatureChars / 8),
					);
				}
			}
			report("serializer", "revised", key, rows);
		});
	}

	it("B2: 3,000 tokens of reasoning plus 200 of text: the budget counts both, the detector's part leaves the reasoning out", () => {
		const reasoning = "We count every event type in the file by hand, line by line, keeping a tally. ".repeat(200);
		const text = "The most common event type is order.shipped (412), then order.created (380). ".repeat(12);
		expect(textTokens(reasoning)).toBeGreaterThan(2_500);
		expect(textTokens(reasoning)).toBeLessThan(3_600);
		expect(textTokens(text)).toBeGreaterThan(150);
		expect(textTokens(text)).toBeLessThan(260);
		for (const model of [MODELS.openai, MODELS.anthropic, MODELS.bedrock]) {
			const message = assistant(model, [
				{ type: "thinking", thinking: reasoning, thinkingSignature: signatureFor(model, 0) },
				{ type: "text", text },
			]);
			const parts = serializedParts(message as never, targetOf(model));
			// Budget: everything Pi sends, reasoning included.
			expect(parts.tokens).toBe(4 + textTokens(reasoning) + textTokens(text));
			// Detector: the appended estimate is tokens - reasoning = the text (and overhead) only.
			expect(parts.reasoning).toBe(textTokens(reasoning));
			expect(parts.tokens - parts.reasoning).toBe(4 + textTokens(text));
		}
		// Unmodelled APIs count everything (r5), and the detector still leaves the reasoning out.
		const faux = assistant(MODELS.openai, [
			{ type: "thinking", thinking: reasoning },
			{ type: "text", text },
		]);
		const any = serializedParts(faux as never, {
			api: "faux-api",
			provider: "faux",
			modelId: "x",
			thinkingAsText: false,
		});
		expect(any.tokens).toBe(messageTokens(faux as never));
		expect(any.reasoning).toBe(textTokens(reasoning));
	});
});
