/**
 * 0.9.0: the provider count API on Gemini (countapi.ts, design section 6), all simulated: the count goes to a fake
 * countTokens endpoint answering with the simulated provider's own count, and no key is read. Flash counts exactly;
 * Gemini 4 counts a tool call with its thoughtSignature 8 below billed and an image above it (29 measured, varied here
 * up to 58), so any request with an image is a fallback sample.
 */
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CountRegistry,
	type CountTarget,
	directCountTarget,
	GEMINI_SIGNED_CALL_EXCESS,
	geminiHistory,
	isWarmPayload,
} from "../../../../../.pi/extensions/penpi/engine/countapi.ts";
import { type ExactSession, endExactSessions, exactSession, prompt } from "./exact-session.ts";
import { finalTurn, geminiPayload, redirectPair, resendAnswered } from "./helpers.ts";

const PNG = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
};

interface CountCall {
	url: string;
	headers: Record<string, string>;
	body: { generateContentRequest: { model: string; contents: unknown[]; systemInstruction?: unknown } };
}

/**
 * A Gemini session on the count path. The fake countTokens answers with the simulated provider's billed count, less
 * GEMINI_SIGNED_CALL_EXCESS a signed tool call in the body (Gemini 4), plus `image(k)` for the k-th image in it, and
 * `bump()` more an image in this count (a variation between counts of the same image).
 */
async function geminiSession(
	model: string,
	options: {
		signed?: boolean;
		image?: (k: number) => number;
		bump?: () => number;
		sim?: Record<string, unknown>;
		engine?: Record<string, unknown>;
	} = {},
): Promise<{ s: ExactSession; calls: CountCall[] }> {
	const calls: CountCall[] = [];
	let s: ExactSession | undefined;
	const target: CountTarget = {
		kind: "gemini",
		url: `https://count.invalid/v1beta/models/${model}:countTokens`,
		headers: { "x-goog-api-key": "test-key" },
	};
	const fake = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as CountCall["body"];
		calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
		const key = JSON.stringify(body.generateContentRequest.contents);
		let call: { promptTokens: number } | undefined;
		for (let i = 0; i < 100 && !call; i++) {
			call = s!.sim.calls.findLast((c) => JSON.stringify(c.payload.contents) === key);
			if (!call) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (!call) return new Response("{}", { status: 400 });
		const history = geminiHistory({ contents: body.generateContentRequest.contents });
		const total =
			call.promptTokens -
			(options.signed ? GEMINI_SIGNED_CALL_EXCESS * history.signedCalls : 0) +
			// Each image's excess is its own (by its place in the history), the same in every count of it.
			Array.from({ length: history.images }, (_, k) => options.image?.(k) ?? 0).reduce((a, b) => a + b, 0) +
			history.images * (options.bump?.() ?? 0);
		return new Response(JSON.stringify({ totalTokens: total }), { status: 200 });
	}) as typeof fetch;
	s = await exactSession(model, {
		window: 200_000,
		count: (text) => Math.ceil(text.length / 4),
		engine: {
			countApiTarget: (key: string) => (key === `faux/${model}` ? target : undefined),
			countApiFetch: fake,
			...options.engine,
		},
		sim: {
			responseDelayMs: 40,
			imageTokens: () => 258,
			payload: (context: TranscriptContext) => geminiPayload(context, { signed: options.signed }),
			...options.sim,
		},
	});
	return { s, calls };
}

async function work(s: ExactSession, prompts: number, from = 1): Promise<void> {
	for (let i = from; i < from + prompts; i++) await prompt(s, [1_500, 2_200, 1_800], i);
}

describe("0.9.0: Gemini's countTokens, simulated", () => {
	afterEach(endExactSessions);

	it("Flash counts exactly: the gate sets, nothing is evidence; the key only in its header, the body a generateContentRequest", async () => {
		const { s, calls } = await geminiSession("gemini-flash-test");
		await work(s, 3);
		expect(calls.length).toBeGreaterThan(5);
		for (const c of calls) {
			expect(c.url).toBe("https://count.invalid/v1beta/models/gemini-flash-test:countTokens");
			expect(c.url).not.toContain("key=");
			expect(c.headers["x-goog-api-key"]).toBe("test-key");
			expect(c.body.generateContentRequest.model).toBe("models/gemini-flash-test");
			expect(c.body.generateContentRequest.systemInstruction).toEqual({ parts: [{ text: "SYSTEM" }] });
			expect(Array.isArray(c.body.generateContentRequest.contents)).toBe(true);
		}
		expect(s.lines.some((l) => l.includes("exactness gate set for faux/gemini-flash-test#count-api"))).toBe(true);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it("Gemini 4's signed tool calls, 8 below billed: allowed on the surplus side, so the gate sets and nothing is evidence", async () => {
		const { s } = await geminiSession("gemini-4-test", { signed: true });
		await work(s, 4);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
		expect(s.lines.filter((l) => l.includes("exact count off"))).toEqual([]);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
	});

	it("the allowance is never on the shortfall side: a truncation among signed calls is still found", async () => {
		const { s } = await geminiSession("gemini-4-test", {
			signed: true,
			sim: { silentLimit: 7_000, silentReport: "remainder" },
		});
		await work(s, 5);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
		expect(s.lines.some((l) => l.includes("silent truncation evidence"))).toBe(true);
	});

	it("an image appended is a fallback sample, and so is every request after it: an honest total and an honest repeat at the maximum are no evidence", async () => {
		// Gemini 4 counts each image 29 to 58 above billed, by image, the same in every count of it.
		const { s } = await geminiSession("gemini-4-test", {
			signed: true,
			image: (k) => 29 + ((k * 7) % 30),
			sim: { imageTokens: () => 30 },
		});
		await work(s, 3);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
		// Forty images, billed small: their excess is well past the drift share of the text.
		s.model.push(finalTurn("seen"));
		await s.harness.session.prompt("Look at these.", { images: Array.from({ length: 40 }, () => PNG) });
		expect(s.lines.some((l) => l.includes("exact sample on the fallback rules: an image appended"))).toBe(true);
		await work(s, 2, 10);
		expect(s.lines.some((l) => l.includes("exact sample on the fallback rules: an image in the history"))).toBe(true);
		// The largest request again: exactly the maximum, an honest repeat.
		await resendAnswered(s.harness, "done 11");
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
		expect(s.lines.filter((l) => l.includes("under the request's exact text count"))).toEqual([]);
		expect(s.lines.filter((l) => l.includes("exact tokens above the request that set it"))).toEqual([]);
	});

	it("an image whose count varies from one count to the next: an honest session with images gives no evidence", async () => {
		// Each count of each image off by up to 15 from the last, which growth on the exact rules would read as shortfalls.
		let n = 0;
		const { s } = await geminiSession("gemini-4-test", {
			signed: true,
			image: () => 29,
			bump: () => [0, 15, -15, 10, -10][n++ % 5],
			sim: { imageTokens: () => 30 },
		});
		await work(s, 3);
		expect(s.lines.some((l) => l.includes("exactness gate set"))).toBe(true);
		s.model.push(finalTurn("seen"));
		await s.harness.session.prompt("Look at these.", { images: Array.from({ length: 10 }, () => PNG) });
		await work(s, 6, 10);
		expect(s.lines.some((l) => l.includes("exact sample on the fallback rules: an image in the history"))).toBe(true);
		expect(s.lines.filter((l) => l.includes("silent truncation"))).toEqual([]);
		expect(s.lines.filter((l) => l.includes("exact count off"))).toEqual([]);
	});

	it("a provider that drops messages, with an image early in the session: the gate never sets while the image is there", async () => {
		const { s } = await geminiSession("gemini-4-test", {
			signed: true,
			image: () => 29,
			sim: { imageTokens: () => 30, silentLimit: 7_000, silentReport: "remainder" },
		});
		s.model.push(finalTurn("seen"));
		await s.harness.session.prompt("Look at this.", { images: [PNG] });
		await work(s, 6);
		// Counted, and truncated with the image in the history: without the rule, these deltas match and the gate sets.
		expect(s.stats.countApi.counted).toBeGreaterThan(5);
		expect(s.sim.calls.some((c) => c.truncatedInput)).toBe(true);
		// The fallback rules find the truncation, and the engine's cut takes the image out of the history. Only then,
		// against a provider no longer truncating, may the gate set.
		const cut = s.lines.findIndex((l) => l.includes("cut #1"));
		const gate = s.lines.findIndex((l) => l.includes("exactness gate set"));
		expect(s.lines.some((l) => l.includes("silent truncation:"))).toBe(true);
		expect(cut).toBeGreaterThan(-1);
		expect(gate === -1 || gate > cut).toBe(true);
	});

	it("a redirect is a count failure: the key never reaches the other origin", async () => {
		const pair = await redirectPair();
		try {
			const target: CountTarget = {
				kind: "gemini",
				url: `${pair.from}/v1beta/models/gemini-flash-test:countTokens`,
				headers: { "x-goog-api-key": "test-key" },
			};
			// The engine's own fetch (globalThis.fetch), not a fake: the redirect is followed or refused by fetch itself.
			const { s } = await geminiSession("gemini-flash-test", {
				engine: { countApiTarget: () => target, countApiFetch: undefined },
			});
			await work(s, 2);
			expect(pair.first).toBeGreaterThan(0);
			expect(pair.reached).toEqual([]);
			expect(s.lines.some((l) => l.includes("count API failure 1/"))).toBe(true);
		} finally {
			await pair.close();
		}
	});

	it("the cache warmer's payload (maxOutputTokens 1) is never counted", () => {
		expect(isWarmPayload({ contents: [], config: { maxOutputTokens: 1 } })).toBe(true);
		expect(isWarmPayload({ contents: [], config: { maxOutputTokens: 8_192 } })).toBe(false);
	});

	it("geminiHistory counts signed calls and images", () => {
		const payload = geminiPayload(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "look" }, PNG], timestamp: 0 },
					{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] } as never,
					{
						role: "toolResult",
						toolCallId: "c1",
						toolName: "read",
						content: [{ type: "text", text: "x" }],
						isError: false,
						timestamp: 0,
					},
				],
			} as unknown as TranscriptContext,
			{ signed: true },
		);
		expect(geminiHistory(payload)).toEqual({ signedCalls: 1, images: 1 });
	});
});

describe("0.9.0: Gemini's direct-key check", () => {
	const model = (over: Partial<Model<Api>>): Model<Api> =>
		({
			id: "gemini-4-pro",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			...over,
		}) as Model<Api>;
	const registry = (auth: { apiKey?: string; baseUrl?: string } | undefined, oauth = false): CountRegistry => ({
		isUsingOAuth: () => oauth,
		getProviderAuth: async () => (auth ? { auth } : undefined),
	});

	it("Google's Gemini API with an API key: countTokens there, the key in x-goog-api-key and never in the URL", async () => {
		const t = await directCountTarget(model({}), registry({ apiKey: "secret-k" }));
		expect(t).toEqual({
			kind: "gemini",
			url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-pro:countTokens",
			headers: { "x-goog-api-key": "secret-k" },
		});
		expect(t!.url).not.toContain("secret-k");
	});

	it("Vertex, a login, OpenRouter or another address: no count", async () => {
		expect(
			await directCountTarget(
				model({ api: "google-vertex" as Api, provider: "google-vertex" }),
				registry({ apiKey: "k" }),
			),
		).toBeUndefined();
		expect(await directCountTarget(model({}), registry({ apiKey: "k" }, true))).toBeUndefined();
		expect(
			await directCountTarget(
				model({ provider: "openrouter", api: "openai-completions" as Api }),
				registry({ apiKey: "k" }),
			),
		).toBeUndefined();
		expect(
			await directCountTarget(model({ baseUrl: "https://proxy.example.com/v1beta" }), registry({ apiKey: "k" })),
		).toBeUndefined();
		// Plain HTTP, as the model's address or the key's: the key would go in plain text.
		expect(
			await directCountTarget(
				model({ baseUrl: "http://generativelanguage.googleapis.com/v1beta" }),
				registry({ apiKey: "k" }),
			),
		).toBeUndefined();
		expect(
			await directCountTarget(
				model({}),
				registry({ apiKey: "k", baseUrl: "http://generativelanguage.googleapis.com/v1beta" }),
			),
		).toBeUndefined();
	});
});
