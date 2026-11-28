/**
 * 0.9.0: the provider count API on Claude (countapi.ts, design section 6), all simulated: the count goes to a fake
 * endpoint that answers with the simulated provider's own count of the request, and no key is read. The count path is
 * the exact path for a Claude model, which has no public tokenizer.
 */
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	COUNT_API_FAILURES,
	type CountRegistry,
	type CountTarget,
	directCountTarget,
	isWarmPayload,
	payloadTail,
	plannedTail,
	tailsMatch,
} from "../../../../../.pi/extensions/penpi/engine/countapi.ts";
import { type ExactSession, endExactSessions, exactSession, prompt } from "./exact-session.ts";
import { anthropicPayload, redirectPair } from "./helpers.ts";

const MODEL = "claude-count";
const KEY = `faux/${MODEL}`;
const TARGET: CountTarget = {
	kind: "claude",
	url: "https://count.invalid/v1/messages/count_tokens",
	headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
};

interface CountCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * A fake count_tokens endpoint: answers with the simulated provider's count of the request the body is, plus `excess`
 * (by call), or with `fail`'s response.
 */
function fakeCount(
	session: () => ExactSession,
	calls: CountCall[],
	options: {
		excess?: (n: number) => number;
		fail?: (n: number) => Response | "hang" | undefined;
		delayMs?: number;
	} = {},
): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		const n = calls.length;
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
		const failure = options.fail?.(n);
		if (failure === "hang")
			return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		if (failure) return failure;
		if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
		const key = JSON.stringify(body.messages);
		let call: { promptTokens: number } | undefined;
		for (let i = 0; i < 100 && !call; i++) {
			call = session().sim.calls.findLast((c) => JSON.stringify(c.payload.messages) === key);
			if (!call) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (!call) return new Response(JSON.stringify({ error: { message: "unknown request" } }), { status: 400 });
		return new Response(JSON.stringify({ input_tokens: call.promptTokens + (options.excess?.(n) ?? 0) }), {
			status: 200,
		});
	}) as typeof fetch;
}

async function countSession(
	options: {
		count?: Parameters<typeof fakeCount>[2];
		engine?: Record<string, unknown>;
		sim?: Record<string, unknown>;
		payload?: (context: TranscriptContext, index: number) => Record<string, unknown>;
		window?: number;
	} = {},
): Promise<{ s: ExactSession; calls: CountCall[] }> {
	const calls: CountCall[] = [];
	let s: ExactSession | undefined;
	s = await exactSession(MODEL, {
		window: options.window ?? 200_000,
		count: (text) => Math.ceil(text.length / 4),
		engine: {
			countApiTarget: (key: string) => (key === KEY ? TARGET : undefined),
			countApiFetch: fakeCount(() => s!, calls, options.count),
			...options.engine,
		},
		sim: {
			// A provider answers after its count does.
			responseDelayMs: 40,
			payload: (context: TranscriptContext, _model: unknown, index: number) => ({
				...anthropicPayload(context),
				betas: ["fine-grained-tool-streaming-2025-05-14", "context-1m-2025-08-07"],
				thread: { type: "create" },
				...options.payload?.(context, index),
			}),
			...options.sim,
		},
	});
	return { s, calls };
}

/** Turns of tool calls: enough samples for the gate and for growth. */
async function work(s: ExactSession, prompts: number, sizes = [1_500, 2_200, 1_800]): Promise<void> {
	for (let i = 0; i < prompts; i++) await prompt(s, sizes, i + 1);
}

describe("0.9.0: Claude's count_tokens, simulated", () => {
	afterEach(endExactSessions);

	it("counts the payload at the engine's handler: the same betas, no output fields and never a thread field; the gate sets", async () => {
		const { s, calls } = await countSession();
		await work(s, 3);
		expect(calls.length).toBeGreaterThan(5);
		for (const c of calls) {
			expect(c.url).toBe(TARGET.url);
			expect(c.headers["x-api-key"]).toBe("test-key");
			expect(c.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07");
			for (const field of ["max_tokens", "thread", "stream", "betas", "fallbacks", "metadata"])
				expect(c.body[field], field).toBeUndefined();
			expect(Array.isArray(c.body.messages)).toBe(true);
		}
		expect(s.lines.some((l) => l.includes(`exactness gate set for ${KEY}#count-api`))).toBe(true);
		expect(s.stats.countApi.counted).toBe(calls.length);
		expect(s.stats.countApi.failures).toBe(0);
		expect(s.lines.filter((l) => l.includes("silent truncation evidence"))).toEqual([]);
	});

	it("finds a silent truncation on the exact path, judged against the count", async () => {
		const { s } = await countSession({ sim: { silentLimit: 7_000, silentReport: "remainder" } });
		await work(s, 5);
		expect(s.lines.some((l) => l.includes(`exactness gate set for ${KEY}#count-api`))).toBe(true);
		const evidence = s.lines.filter((l) => l.includes("silent truncation evidence"));
		expect(evidence.length).toBeGreaterThan(0);
		expect(evidence[0]).toMatch(/exact append \d+, reported usage/);
	});

	it('countApi "off": no count call, and every sample on the fallback rules', async () => {
		const { s, calls } = await countSession({ engine: { countApi: "off" } });
		await work(s, 2);
		expect(calls).toEqual([]);
		expect(s.lines.some((l) => l.includes("exactness gate"))).toBe(false);
	});

	it("a constant excess beyond the tolerance (a later extension that redacts text) never sets the gate, and detects nothing", async () => {
		const { s, calls } = await countSession({ count: { excess: () => 40 } });
		await work(s, 3);
		expect(calls.length).toBeGreaterThan(5);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(false);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it("a small variable excess, within the tolerance, sets the gate and detects nothing", async () => {
		const { s } = await countSession({ count: { excess: (n) => (n % 5) - 2 } });
		await work(s, 3);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it(`${COUNT_API_FAILURES} failures in a row turn it off for the session, with one notice naming the reason (a refused beta)`, async () => {
		const refused = () =>
			new Response(
				JSON.stringify({
					error: { message: "Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header" },
				}),
				{
					status: 400,
				},
			);
		const { s, calls } = await countSession({ count: { fail: refused } });
		await work(s, 3);
		expect(calls.length).toBe(COUNT_API_FAILURES);
		expect(s.stats.countApi.failures).toBe(COUNT_API_FAILURES);
		expect(s.stats.countApi.off).toContain("context-1m-2025-08-07");
		expect(s.lines.filter((l) => l.includes("count API off for this session"))).toHaveLength(1);
		expect(s.lines.some((l) => l.includes("exactness gate"))).toBe(false);
	});

	it("a timeout is a failure; a count still out when its sample is judged is late, and a fallback sample", async () => {
		const hang = await countSession({ count: { fail: () => "hang" }, engine: { countApiTimeoutMs: 30 } });
		await work(hang.s, 2);
		expect(hang.s.stats.countApi.failures).toBe(COUNT_API_FAILURES);
		expect(hang.s.stats.countApi.off).toBe("timed out");
		await endExactSessions();
		const slow = await countSession({ count: { delayMs: 400 } });
		await work(slow.s, 2);
		expect(slow.s.stats.countApi.late).toBeGreaterThan(0);
		expect(slow.s.stats.countApi.failures).toBe(0);
		expect(slow.s.lines.some((l) => l.includes("exactness gate set"))).toBe(false);
	});

	it("a timeout on a body over 1 MB is late, not a failure", async () => {
		const { s } = await countSession({
			count: { fail: () => "hang" },
			engine: { countApiTimeoutMs: 30 },
			payload: () => ({ system: [{ type: "text", text: "x".repeat(1_100_000) }] }),
		});
		await work(s, 2);
		expect(s.stats.countApi.calls).toBeGreaterThan(COUNT_API_FAILURES);
		expect(s.stats.countApi.failures).toBe(0);
		expect(s.stats.countApi.late).toBe(s.stats.countApi.calls);
		expect(s.stats.countApi.off).toBeUndefined();
	});

	it("above 1 MB, only requests near the largest usage are counted, and the request before each with it", async () => {
		const { s, calls } = await countSession({
			window: 32_000,
			payload: () => ({ system: [{ type: "text", text: "x".repeat(1_100_000) }] }),
		});
		await work(s, 10, [6_000, 7_000, 6_500]);
		expect(s.stats.cuts.length).toBeGreaterThan(0);
		expect(s.stats.countApi.skipped["a body over 1 MB, not near the largest usage"]).toBeGreaterThan(0);
		// Which request each count was of; a request counted after the one after it is a "before" count.
		const of = calls.map((c) =>
			s.sim.calls.findIndex((sc) => JSON.stringify(sc.payload.messages) === JSON.stringify(c.body.messages)),
		);
		expect(of.every((i) => i >= 0)).toBe(true);
		const before = of.filter((i, k) => k > 0 && i === of[k - 1] - 1);
		expect(before.length).toBeGreaterThan(0);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it("above 1 MB, the request before isn't counted when it named fallbacks and its response named no model", async () => {
		// As apply: such a response may be a fallback model's, so its count must not become the next delta's base.
		const { s, calls } = await countSession({
			window: 32_000,
			payload: () => ({
				system: [{ type: "text", text: "x".repeat(1_100_000) }],
				fallbacks: [{ model: "claude-fallback" }],
			}),
		});
		await work(s, 10, [6_000, 7_000, 6_500]);
		const of = calls.map((c) =>
			s.sim.calls.findIndex((sc) => JSON.stringify(sc.payload.messages) === JSON.stringify(c.body.messages)),
		);
		expect(of.length).toBeGreaterThan(0);
		expect(of.filter((i, k) => k > 0 && i === of[k - 1] - 1)).toEqual([]);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it("a 429 on a count pauses counting; a 429 on the request is never evidence", async () => {
		const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "30" } });
		const { s, calls } = await countSession({ count: { fail: (n) => (n === 0 ? limited() : undefined) } });
		await work(s, 2);
		expect(calls).toHaveLength(1);
		expect(s.stats.countApi.rateLimited).toBe(1);
		expect(s.stats.countApi.skipped["paused after a 429"]).toBeGreaterThan(0);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
		await endExactSessions();
		const request = await countSession({ sim: { responseStatus: (i: number) => (i === 4 ? 429 : undefined) } });
		await work(request.s, 3);
		expect(request.s.stats.countApi.skipped["the request got a 429"]).toBe(1);
		expect(request.s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it("served by another model, or fallbacks named with none reported: fallback samples, and the gate doesn't drop", async () => {
		const { s } = await countSession({
			sim: {
				streamData: (i: number) => ({
					type: "message_start",
					message: { model: i === 9 ? "claude-fallback" : MODEL },
				}),
			},
			payload: (_c, i) => (i === 11 ? { fallbacks: [{ model: "claude-fallback" }] } : {}),
		});
		await work(s, 4);
		expect(s.lines.some((l) => l.includes("count API: served by claude-fallback, not claude-count"))).toBe(true);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
		expect(s.lines.some((l) => l.includes("exactness gate dropped"))).toBe(false);
		await endExactSessions();
		const unnamed = await countSession({ payload: () => ({ fallbacks: [{ model: "claude-fallback" }] }) });
		await work(unnamed.s, 2);
		expect(unnamed.s.lines.some((l) => l.includes("names fallback models and the response names none"))).toBe(true);
		expect(unnamed.s.lines.some((l) => l.includes("exactness gate set"))).toBe(false);
	});

	it("a payload that doesn't end as planned isn't counted; a request ending in two tool results is", async () => {
		const { s } = await countSession({
			payload: (context, i) =>
				i === 6
					? {
							messages: [
								...(anthropicPayload(context).messages as unknown[]),
								{ role: "user", content: "added later" },
							],
						}
					: {},
		});
		await work(s, 3);
		expect(s.stats.countApi.skipped["the payload doesn't match the planned request"]).toBe(1);
		const twoResults = {
			messages: [
				{ role: "user", content: "go", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "a1", name: "read", arguments: {} },
						{ type: "toolCall", id: "a2", name: "read", arguments: {} },
					],
				} as never,
				{
					role: "toolResult",
					toolCallId: "a1",
					toolName: "read",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "a2",
					toolName: "read",
					content: [{ type: "text", text: "2" }],
					isError: false,
					timestamp: 0,
				},
			],
		} as unknown as TranscriptContext;
		const payload = anthropicPayload(twoResults);
		expect((payload.messages as unknown[]).length).toBe(3);
		expect(tailsMatch(plannedTail(twoResults.messages as never), payloadTail("claude", payload))).toBe(true);
		expect(tailsMatch({ toolIds: ["a1"], toolNames: ["read"] }, payloadTail("claude", payload))).toBe(false);
	});

	it("a redirect is a count failure: the key never reaches the other origin", async () => {
		const pair = await redirectPair();
		try {
			const target: CountTarget = { ...TARGET, url: `${pair.from}/v1/messages/count_tokens` };
			// The engine's own fetch (globalThis.fetch), not a fake: the redirect is followed or refused by fetch itself.
			const { s } = await countSession({ engine: { countApiTarget: () => target, countApiFetch: undefined } });
			await work(s, 2);
			expect(pair.first).toBeGreaterThan(0);
			expect(pair.reached).toEqual([]);
			expect(s.lines.some((l) => l.includes("count API failure 1/"))).toBe(true);
		} finally {
			await pair.close();
		}
	});

	it("the cache warmer's payload (max_tokens 1) is never counted", async () => {
		expect(isWarmPayload({ max_tokens: 1, messages: [] })).toBe(true);
		expect(isWarmPayload({ max_tokens: 4_000, messages: [] })).toBe(false);
		const { s, calls } = await countSession({ payload: (_c, i) => (i === 3 ? { max_tokens: 1 } : {}) });
		await work(s, 2);
		const counted = new Set(calls.map((c) => JSON.stringify(c.body.messages)));
		expect(counted.has(JSON.stringify(s.sim.calls[3].payload.messages))).toBe(false);
	});

	it("thread requests are ordinary samples: the count is of the full request, without the thread", async () => {
		const { s, calls } = await countSession({
			payload: (_c, i) => ({ thread: { type: i > 2 ? "continue" : "create" } }),
		});
		await work(s, 3);
		expect(calls.every((c) => c.body.thread === undefined)).toBe(true);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
	});
});

describe("0.9.0: the count API's direct-key check", () => {
	const model = (over: Partial<Model<Api>>): Model<Api> =>
		({
			id: "claude-sonnet-5-5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			...over,
		}) as Model<Api>;
	const registry = (auth: { apiKey?: string; baseUrl?: string } | undefined, oauth = false): CountRegistry => ({
		isUsingOAuth: () => oauth,
		getProviderAuth: async () => (auth ? { auth } : undefined),
	});

	it("Anthropic's own API with an API key: count_tokens there, the key in x-api-key", async () => {
		expect(await directCountTarget(model({}), registry({ apiKey: "k" }))).toEqual({
			kind: "claude",
			url: "https://api.anthropic.com/v1/messages/count_tokens",
			headers: { "x-api-key": "k", "anthropic-version": "2023-06-01" },
		});
	});

	it("a login, OpenRouter, Bedrock, another address or no key: no count", async () => {
		expect(await directCountTarget(model({}), registry({ apiKey: "k" }, true))).toBeUndefined();
		expect(
			await directCountTarget(
				model({ provider: "openrouter", baseUrl: "https://openrouter.ai/api" }),
				registry({ apiKey: "k" }),
			),
		).toBeUndefined();
		expect(
			await directCountTarget(
				model({ api: "bedrock-converse-stream" as Api, provider: "amazon-bedrock" }),
				registry({ apiKey: "k" }),
			),
		).toBeUndefined();
		expect(
			await directCountTarget(model({ baseUrl: "https://proxy.example.com" }), registry({ apiKey: "k" })),
		).toBeUndefined();
		expect(
			await directCountTarget(model({}), registry({ apiKey: "k", baseUrl: "https://proxy.example.com" })),
		).toBeUndefined();
		expect(await directCountTarget(model({}), registry({}))).toBeUndefined();
		// Plain HTTP, as the model's address or the key's: the key would go in plain text.
		expect(
			await directCountTarget(model({ baseUrl: "http://api.anthropic.com" }), registry({ apiKey: "k" })),
		).toBeUndefined();
		expect(
			await directCountTarget(model({}), registry({ apiKey: "k", baseUrl: "http://api.anthropic.com" })),
		).toBeUndefined();
		expect(await directCountTarget(model({}), undefined)).toBeUndefined();
	});
});
