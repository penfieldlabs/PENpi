/**
 * 0.9.0, commit 4 (design sections 2 to 4): the budget on exact counts. A model the classifier places on a tokenizer
 * is counted by the worker; the planner prices each counted part at its exact count times the exact key's ratio, and
 * the rest at the estimate times the fallback ratio. Detection stays on the estimate.
 *
 * The provider here counts with the model's own tokenizer, plus a few template tokens per message, so the exact
 * ratio settles just above 1 and the budget's prediction matches what the provider reports.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineStats } from "../../../../../.pi/extensions/penpi/engine/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { HF_DIR, verifiedRequire } from "../context-engine-e2/tokenizer-cache.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats, STATE_TYPE } from "./engine.ts";
import {
	endSession,
	finalTurn,
	installProviderSim,
	type ProviderSim,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";
import { o200kTokens } from "./tokenizers.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await endSession(harnesses.pop()!);
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Template tokens the provider adds per message (a chat template's role markers). */
const TEMPLATE = 3;

function cacheDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "penpi-tokenizers-"));
	dirs.push(dir);
	return dir;
}

async function until(condition: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

interface Session {
	harness: Harness;
	stats: EngineStats;
	lines: string[];
	reports: string[];
	sim: ProviderSim;
	model: ReturnType<typeof scriptedModel>;
}

async function session(
	modelId: string | string[],
	options: {
		count?: (text: string) => number;
		engine?: Record<string, unknown>;
		window?: number;
		sim?: Parameters<typeof installProviderSim>[1];
		tools?: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<Session> {
	const stats = newStats();
	const lines: string[] = [];
	const reports: string[] = [];
	const harness = await createHarness({
		models: (Array.isArray(modelId) ? modelId : [modelId]).map((id) => ({
			id,
			contextWindow: options.window ?? 32_000,
			maxTokens: 4_000,
		})),
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			...(options.tools ?? []),
			createContextEngine({
				stats,
				env: {},
				tokenizerCacheDir: cacheDir(),
				log: (line: string) => lines.push(line),
				report: (json: string) => reports.push(json),
				...options.engine,
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const count = options.count;
	const sim = installProviderSim(harness, {
		...(count ? { countTokens: (parts: string[]) => parts.reduce((sum, p) => sum + count(p) + TEMPLATE, 0) } : {}),
		...options.sim,
	});
	const model = scriptedModel(harness);
	return { harness, stats, lines, reports, sim, model };
}

/** A prompt of `turns` tool turns of the given sizes, then a final answer. */
async function prompt(s: Session, sizes: number[], seed: number, text = `Task ${seed}`): Promise<void> {
	sizes.forEach((size, i) => {
		s.model.push(toolTurn(size, seed * 100 + i));
	});
	s.model.push(finalTurn(`done ${seed}`));
	await s.harness.session.prompt(text);
}

describe("0.9.0: the budget on exact counts", () => {
	it("a model on o200k is counted exactly: one counting line, counts kept across requests, the budget matches the provider", async () => {
		const s = await session("gpt-4o-test", { count: o200kTokens });
		await prompt(s, [600], 1);
		// The bundled tokenizer loads in the background; requests meanwhile are on the estimate.
		await until(() => s.reports.some((r) => r.includes('"path":"exact"')));
		for (let p = 2; p <= 6; p++) await prompt(s, [1_500, 2_500, 1_000], p);
		expect(s.reports.filter((r) => r.includes('"k":"counting"'))).toEqual([
			'{"k":"counting","path":"exact","entry":"o200k","reason":null}',
		]);
		expect(s.stats.exact.samples).toBeGreaterThan(10);
		// Each message is counted once, when a request first carries it: the texts sent stay about one per message.
		const messages = s.harness.sessionManager.getBranch().filter((e) => e.type === "message").length;
		expect(s.stats.exact.texts).toBeLessThan(messages * 2);
		const before = s.stats.exact.texts;
		await prompt(s, [800], 7);
		expect(s.stats.exact.texts - before).toBeLessThanOrEqual(8);
		// The exact ratio settles near 1: the provider's 3 template tokens a message against the 4 the serializer prices
		// per message on either path. A request counted whole is priced at exact x that ratio.
		const last = s.stats.sent.filter((x) => x.exact !== undefined).at(-1)!;
		const ratio = last.priced! / last.exact!;
		expect(ratio).toBeGreaterThan(0.95);
		expect(ratio).toBeLessThan(1.1);
		// Requests counted whole are priced at exact x the exact ratio: within 2% of what the provider reports, from the
		// third exact sample on.
		const exactCalls = s.stats.sent
			.map((sent, i) => ({ sent, call: s.sim.calls[i] }))
			.filter((x) => x.sent.exact !== undefined);
		for (const { sent, call } of exactCalls.slice(3))
			expect(Math.abs(sent.priced! - call.promptTokens) / call.promptTokens).toBeLessThan(0.02);
		// Detection stays on the estimate: nothing was judged truncated.
		expect(s.stats.plateaus).toEqual([]);
	});

	it("a session with no request still writes its counting line: the tokenizer loads with the session", async () => {
		const s = await session("gpt-4o-test", { count: o200kTokens });
		await until(() => s.reports.length > 0);
		expect(s.reports).toEqual(['{"k":"counting","path":"exact","entry":"o200k","reason":null}']);
		expect(s.sim.calls).toEqual([]);
	});

	it("the fallback ratio stays warm during an exact stretch, and exact keys stay out of the prior pool", async () => {
		const s = await session("gpt-4o-test", { count: (t) => Math.ceil(o200kTokens(t) * 1.3) });
		await prompt(s, [600], 1);
		await until(() => s.reports.some((r) => r.includes('"path":"exact"')));
		for (let p = 2; p <= 5; p++) await prompt(s, [2_000, 1_500], p);
		// Both keys learned: the fallback key (provider/model) beside the exact one.
		const keys = new Map<string, number>();
		for (const e of s.harness.sessionManager.getBranch()) {
			if (e.type !== "custom" || e.customType !== STATE_TYPE) continue;
			const data = e.data as { kind?: string; key?: string; ratio?: number };
			if (data.kind === "model" && data.key) keys.set(data.key, data.ratio!);
		}
		const fallbackKey = [...keys.keys()].find((k) => !k.includes("#"));
		expect(fallbackKey).toBeDefined();
		expect(s.stats.sent.at(-1)!.ratio).toBeGreaterThan(1.1);
		const last = s.stats.sent.filter((x) => x.exact !== undefined).at(-1)!;
		expect(last.priced! / last.exact!).toBeGreaterThan(1.25);
	});
});

describe("0.9.0: the band, the cache warmer, and requests that don't wait", () => {
	const require = verifiedRequire();
	const { Tiktoken } = require("js-tiktoken/lite") as {
		Tiktoken: new (
			ranks: unknown,
		) => { encode(text: string, allowed: "all" | string[], disallowed?: string[]): number[] };
	};
	const ranks = require("js-tiktoken/ranks/o200k_base") as { default?: unknown };
	const o200k = new Tiktoken(ranks.default ?? ranks);
	const SPECIALS = `${"<|endoftext|> ".repeat(300)}\n`;

	it("text holding special-token strings is counted both ways, and the budget takes the larger", async () => {
		const special = (pi: ExtensionAPI) =>
			pi.registerTool({
				name: "special",
				label: "special",
				description: "Return text quoting a special token.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: SPECIALS }], details: {} }),
			});
		const s = await session("gpt-4o-test", { count: o200kTokens, tools: [special] });
		await prompt(s, [600], 1);
		await until(() => s.reports.some((r) => r.includes('"path":"exact"')));
		await prompt(s, [600], 2);
		const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
		s.model.push(() =>
			fauxAssistantMessage([fauxToolCall("special", {}, { id: "call-special" })], { stopReason: "toolUse" }),
		);
		s.model.push(finalTurn("done special"));
		const before = s.stats.sent.length;
		await s.harness.session.prompt("Quote it.");
		// The request after the tool result carries it: counted whole on the exact path.
		const sent = s.stats.sent.slice(before);
		const first = sent[0];
		const withResult = sent[1];
		expect(first.exact).toBeDefined();
		expect(withResult.exact).toBeDefined();
		const asOne = o200k.encode(SPECIALS, "all").length;
		const asText = o200k.encode(SPECIALS, [], []).length;
		expect(asText - asOne).toBeGreaterThan(1_000);
		// The tool call and its result added at least the result's count as text, the larger of the two.
		expect(withResult.exact! - first.exact!).toBeGreaterThanOrEqual(asText);
	});

	it("a cache-warming request is never counted and never becomes a sample", async () => {
		const s = await session("gpt-4o-test", { count: o200kTokens });
		await prompt(s, [600], 1);
		await until(() => s.reports.some((r) => r.includes('"path":"exact"')));
		await prompt(s, [1_000], 2);
		// Like CacheWarmer.refresh: the last request replayed with maxTokens 1, straight to the provider.
		const agent = s.harness.session.agent;
		const inner = agent.streamFunction;
		let warmed = 0;
		// The warm request's own scripted answer, as a real warm reply is not the next turn's.
		s.model.push(finalTurn("warm"));
		agent.streamFunction = async (model, context, options) => {
			if (warmed === 0) {
				warmed++;
				await (await inner(model, context, { ...options, maxTokens: 1, maxRetries: 0 })).result();
			}
			return inner(model, context, options);
		};
		const before = { sim: s.sim.calls.length, sent: s.stats.sent.length, samples: s.stats.exact.samples };
		const answers = () =>
			s.harness.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "assistant")
				.length;
		const answersBefore = answers();
		await prompt(s, [800], 3);
		expect(warmed).toBe(1);
		// Three provider calls (the warm one, then the two real requests); the engine planned only the two real ones.
		expect(s.sim.calls.length - before.sim).toBe(3);
		expect(s.sim.calls[before.sim].maxTokens).toBe(1);
		expect(s.stats.sent.length - before.sent).toBe(2);
		expect(s.stats.exact.samples - before.samples).toBe(2);
		// The warm reply was never appended, so it never became a sample.
		expect(answers() - answersBefore).toBe(2);
	});

	it("misses that would take over a second aren't waited for: the request goes on the estimate, the counts land later", async () => {
		const s = await session(["faux-1m", "gpt-4o-test"], { count: o200kTokens, window: 1_000_000 });
		// A long history on a model with no tokenizer, then a switch to one with a tokenizer, as a resume does.
		for (let p = 1; p <= 4; p++) await prompt(s, [20_000, 20_000, 20_000, 20_000, 20_000], p);
		await s.harness.session.setModel(s.harness.getModel("gpt-4o-test")!);
		await prompt(s, [600], 5);
		await until(() => s.reports.some((r) => r.includes('"path":"exact"')));
		const before = s.stats.sent.length;
		await prompt(s, [600], 6);
		// Its first request found every message uncounted: predicted well over a second, so it didn't wait.
		const handler = s.stats.handlerMs.slice(before);
		expect(Math.max(...handler)).toBeLessThan(500);
		expect(s.stats.sent[before].exact).toBeUndefined();
		// The background count lands; a later request is counted whole.
		let counted = false;
		for (let p = 7; p < 20 && !counted; p++) {
			await prompt(s, [600], p);
			counted = s.stats.sent.at(-1)!.exact !== undefined;
			if (!counted) await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		expect(counted).toBe(true);
	});

	it("a Claude model on the fallback path starts at the Claude prior, 1.6", async () => {
		const s = await session("claude-sonnet-test");
		await prompt(s, [600], 1);
		expect(s.stats.sent[0].ratio).toBe(1.6);
		expect(s.reports).toEqual(['{"k":"counting","path":"fallback","entry":null,"reason":"no public tokenizer"}']);
	});
});

/**
 * A fake tokenizer worker for session tests: loads at once, counts each text with o200k after `delay` ms, and can be
 * told to crash, or to throw from postMessage on a count.
 */
function fakeWorker(behaviour: {
	delay?: number | ((count: number) => number);
	crashOnCount?: number;
	throwOnCount?: boolean;
	onCount?: () => void;
}) {
	const listeners: Record<string, Array<(value: unknown) => void>> = {};
	const emit = (event: string, value: unknown) => {
		for (const l of listeners[event] ?? []) l(value);
	};
	let counts = 0;
	let dead = false;
	const worker = {
		on(event: string, listener: (value: unknown) => void) {
			const list = listeners[event] ?? [];
			list.push(listener);
			listeners[event] = list;
			return worker;
		},
		postMessage(message: { type: string; id?: number; texts?: string[] }) {
			if (dead) return;
			if (message.type === "load") {
				queueMicrotask(() => emit("message", { type: "ready", id: "o200k", ms: 1 }));
				return;
			}
			if (message.type !== "count") return;
			counts++;
			if (behaviour.throwOnCount) throw new Error("postMessage failed");
			behaviour.onCount?.();
			if (behaviour.crashOnCount !== undefined && counts >= behaviour.crashOnCount) {
				dead = true;
				queueMicrotask(() => emit("error", new Error("worker died")));
				return;
			}
			setTimeout(
				() => {
					if (dead) return;
					const texts = message.texts!;
					emit("message", {
						type: "chunk",
						id: message.id,
						from: 0,
						counts: texts.map((t) => o200kTokens(t)),
						ms: 1,
						chars: texts.reduce((n, t) => n + t.length, 0),
					});
					emit("message", { type: "done", id: message.id });
				},
				typeof behaviour.delay === "function" ? behaviour.delay(counts) : (behaviour.delay ?? 0),
			);
		},
		terminate() {
			dead = true;
			return undefined;
		},
	};
	return worker;
}

describe("0.9.0: the worker's failures, at session level", () => {
	it("a worker that dies mid-session: requests still go out on the estimate, one restart, then the fallback with one notice", async () => {
		const workers = [fakeWorker({ crashOnCount: 3 }), fakeWorker({ crashOnCount: 1 })];
		let started = 0;
		const s = await session("gpt-4o-test", {
			count: o200kTokens,
			engine: { tokenizerWorker: () => workers[Math.min(started++, workers.length - 1)] },
		});
		for (let p = 1; p <= 6; p++) await prompt(s, [1_000, 800], p);
		expect(started).toBe(2);
		expect(s.lines.some((l) => l.includes("tokenizer worker restarting"))).toBe(true);
		expect(s.reports).toEqual([
			'{"k":"counting","path":"exact","entry":"o200k","reason":null}',
			'{"k":"counting","path":"fallback","entry":null,"reason":"tokenizer worker failed"}',
		]);
		expect(s.lines.filter((l) => l.includes("with the estimate"))).toEqual([
			"[a] context engine: counting faux/gpt-4o-test with the estimate (tokenizer worker failed)",
		]);
		// Every request went out: three per prompt.
		expect(s.sim.calls.length).toBe(18);
		expect(s.lines.some((l) => l.includes("context_with_system error"))).toBe(false);
	});

	it("a count the worker can't take leaves every request planned, on the estimate", async () => {
		const s = await session("gpt-4o-test", {
			count: o200kTokens,
			engine: { tokenizerWorker: () => fakeWorker({ throwOnCount: true }) },
		});
		for (let p = 1; p <= 3; p++) await prompt(s, [1_000], p);
		expect(s.sim.calls.length).toBe(6);
		expect(s.stats.exact.samples).toBe(0);
		expect(s.lines.some((l) => l.includes("context_with_system error"))).toBe(false);
	});

	it("a message appended to the session during the await: the request is planned as Pi sent it, aligned", async () => {
		let harness: Harness | undefined;
		let appended = 0;
		const s = await session("gpt-4o-test", {
			count: o200kTokens,
			engine: {
				tokenizerWorker: () =>
					fakeWorker({
						delay: 100,
						onCount: () => {
							// While the handler waits for this count, an extension writes a message into the session.
							harness?.sessionManager.appendCustomMessageEntry(
								"test.during-await",
								`a note, ${appended++}`,
								true,
							);
						},
					}),
			},
		});
		harness = s.harness;
		for (let p = 1; p <= 4; p++) await prompt(s, [2_000, 1_500], p);
		expect(appended).toBeGreaterThan(0);
		expect(s.lines.filter((l) => l.includes("planned as Pi sent it")).length).toBeGreaterThan(0);
		// Without the leaf from before the await, the index would hold the new message and Pi's request wouldn't.
		expect(s.stats.alignMismatches).toBe(0);
		expect(s.lines.some((l) => l.includes("do not match the engine's record of the session"))).toBe(false);
		expect(s.stats.exact.samples).toBeGreaterThan(0);
	});

	it("a count that takes longer than the deadline: the request goes out at the deadline, the counts land later", async () => {
		const s = await session("gpt-4o-test", {
			count: o200kTokens,
			// Slow for its first counts, then quick.
			engine: { tokenizerWorker: () => fakeWorker({ delay: (n) => (n <= 3 ? 600 : 0) }) },
		});
		await prompt(s, [600], 1);
		const before = s.stats.handlerMs.length;
		await prompt(s, [1_000], 2);
		// The deadline is 200 ms here (the misses are small); the worker answers after 600.
		const waited = s.stats.handlerMs.slice(before);
		expect(Math.max(...waited)).toBeLessThan(500);
		expect(Math.max(...waited)).toBeGreaterThanOrEqual(150);
		await new Promise((resolve) => setTimeout(resolve, 800));
		await prompt(s, [600], 3);
		expect(s.stats.exact.samples).toBeGreaterThan(0);
	});
});

describe("0.9.0: the counting path's settings", () => {
	it("an unknown PENPI_TOKENIZER is warned about once, at the call that reads it, and ignored", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const s = await session("faux-32k", { engine: { env: { PENPI_TOKENIZER: "exactly" } } });
		await prompt(s, [600], 1);
		const lines = s.lines.filter((l) => l.includes("PENPI_TOKENIZER"));
		expect(lines).toEqual(['[a] ignoring PENPI_TOKENIZER="exactly": "auto", "local" or "estimate"']);
		expect(warn.mock.calls.filter((c) => String(c[0]).includes("PENPI_TOKENIZER")).length).toBe(1);
	});

	it("a model with no public tokenizer is on the fallback path: one counting line, no notice", async () => {
		const s = await session("faux-32k");
		await prompt(s, [600], 1);
		await prompt(s, [600], 2);
		expect(s.reports).toEqual(['{"k":"counting","path":"fallback","entry":null,"reason":"no public tokenizer"}']);
		expect(s.lines.some((l) => l.includes("counting") && l.includes("with the estimate"))).toBe(false);
	});

	it("PENPI_TOKENIZER=estimate turns exact counting off", async () => {
		const s = await session("gpt-4o-test", { count: o200kTokens, engine: { env: { PENPI_TOKENIZER: "estimate" } } });
		await prompt(s, [600], 1);
		await prompt(s, [600], 2);
		expect(s.reports).toEqual(['{"k":"counting","path":"fallback","entry":null,"reason":"turned off"}']);
		expect(s.stats.exact.calls).toBe(0);
	});
});

describe("0.9.0: the counting path offline (the gate's sandbox, PI_OFFLINE=1)", () => {
	const glmFile = join(HF_DIR, "tokenizer.json");
	const GLM_SHA = "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d";

	it("offline with no file: one warning naming the model and the fallback, and no request at all", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("no network in this test");
		});
		vi.stubGlobal("fetch", fetch);
		const s = await session("glm-5.1", { engine: { env: { PI_OFFLINE: "1" } } });
		await prompt(s, [600], 1);
		await until(() => s.reports.length > 0);
		await prompt(s, [600], 2);
		expect(s.reports).toEqual(['{"k":"counting","path":"fallback","entry":null,"reason":"offline"}']);
		const warnings = s.lines.filter((l) => l.includes("with the estimate"));
		expect(warnings).toEqual(["[a] context engine: counting faux/glm-5.1 with the estimate (offline)"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.skipIf(!existsSync(glmFile))(
		"offline with the file placed in the cache folder: the exact path, with no request",
		async () => {
			const fetch = vi.fn(async () => {
				throw new Error("no network in this test");
			});
			vi.stubGlobal("fetch", fetch);
			// The bench's layout: <agent dir>/cache/penpi/tokenizers/<sha256>, under PENPI_TOKENIZER=local and PI_OFFLINE=1.
			const dir = cacheDir();
			mkdirSync(dir, { recursive: true });
			verifiedRequire();
			copyFileSync(glmFile, join(dir, GLM_SHA));
			const s = await session("glm-5.1", {
				engine: { env: { PI_OFFLINE: "1", PENPI_TOKENIZER: "local" }, tokenizerCacheDir: dir },
			});
			await prompt(s, [600], 1);
			await until(() => s.reports.length > 0, 60_000);
			await prompt(s, [600], 2);
			expect(s.reports).toEqual(['{"k":"counting","path":"exact","entry":"glm5","reason":null}']);
			expect(s.lines.some((l) => l.includes("with the estimate"))).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
