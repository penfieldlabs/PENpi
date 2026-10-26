/**
 * P4: shortly before a cut, the request ends with a one-line notice (never persisted) that names what
 * will leave view, so the model can save it first. Invariants: the notice is only ever the last
 * message, never stored, every request stays valid, and the prefix still changes only at cuts.
 */
import type { Message, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, ENGINE_LABEL, type EngineOptions, newStats } from "./engine.ts";
import { analyzePrefixes, finalTurn, report, rng, scriptedModel, validateRequest, workExtension } from "./helpers.ts";

const MARKER = "[context-engine notice]";

// D13: entry ids are deterministic in the whole suite (deterministic-ids.ts); each run starts them again.
const FIXTURE_SEEDS = [13, 14];

describe("pre-cut notice", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** 6 prompts x 25 turns on a 32k model: about 150 requests and 10 cuts. */
	async function run(seed: number, noticeRepeats?: boolean, engine: Partial<EngineOptions> = {}) {
		resetEntryIds();
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({
					mode: "a",
					stats,
					// P3: the notice ships off; this file tests the notice path (an `engine` override still wins).
					notice: true,
					...(noticeRepeats === undefined ? {} : { noticeRepeats }),
					...engine,
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness);
		const next = rng(seed);
		let step = 0;
		for (let p = 0; p < 6; p++) {
			for (let t = 0; t < 24; t++) {
				const s = step++;
				const size = 1_000 + Math.floor(next() * 4_000);
				model.push(() =>
					fauxAssistantMessage(
						[
							fauxText(`Step ${s}.`),
							fauxToolCall("work", { size, seed: s, path: `src/module-${s % 7}.ts` }, { id: `call-${s}` }),
						],
						{
							stopReason: "toolUse",
						},
					),
				);
			}
			model.push(finalTurn(`done ${p}`));
			await harness.session.prompt(`Task ${p}`);
		}
		const isNotice = (m: string) => m.includes(MARKER);
		const withNotice = model.requests.map((r, i) => (r.some(isNotice) ? i : -1)).filter((i) => i >= 0);
		const prefix = analyzePrefixes(model.requests, isNotice);
		const breaks = prefix.breakAt;
		// Cut cycles: requests from one prefix break up to the next. A cycle "warned" if a notice fell in it.
		const bounds = [0, ...breaks, model.requests.length];
		const cycles = bounds.slice(1).map((end, i) => withNotice.filter((r) => r >= bounds[i] && r < end).length);
		return {
			stats,
			harness,
			model,
			isNotice,
			withNotice,
			prefix,
			breaks,
			cycles,
			misplaced: model.requests.filter((r) => r.slice(0, -1).some(isNotice)).length,
			persisted: harness.sessionManager.getEntries().some((e) => JSON.stringify(e).includes(MARKER)),
			cutsWithNoticeRightBefore: breaks.filter((i) => withNotice.includes(i - 1)).length,
			cutsWithNoticeInCycle: cycles.slice(0, breaks.length).filter((n) => n > 0).length,
		};
	}

	for (const seed of FIXTURE_SEEDS) {
		it(`notice: false sends no notice, with or without repeats, and cuts as before (fixture seed ${seed})`, async () => {
			const on = await run(seed);
			const off = await run(seed, undefined, { notice: false });
			const offRepeats = await run(seed, true, { notice: false });
			report("p4", ENGINE_LABEL, `notice-off.${seed}`, {
				on: { notices: on.withNotice.length, cuts: on.stats.cuts.length },
				off: { notices: off.withNotice.length, counted: off.stats.notices, cuts: off.stats.cuts.length },
				offRepeats: { notices: offRepeats.withNotice.length, counted: offRepeats.stats.notices },
			});
			expect(on.withNotice.length).toBeGreaterThan(0);
			for (const r of [off, offRepeats]) {
				expect(r.withNotice).toHaveLength(0);
				expect(r.stats.notices).toBe(0);
				expect(r.misplaced).toBe(0);
				expect(r.prefix.breaks).toBe(r.stats.cuts.length);
			}
			// D13: the runs name the same entry ids, so the headers estimate alike.
			const idsOf = (r: typeof on) => r.harness.sessionManager.getEntries().map((e) => e.id);
			expect(idsOf(off)).toEqual(idsOf(on));
			expect(idsOf(on)[0]).toBe("00000000");
			// The notice is request-only, so switching it off leaves the cuts where they were.
			expect(off.stats.cuts.map((c) => c.seq)).toEqual(on.stats.cuts.map((c) => c.seq));
			expect(off.prefix.breakAt).toEqual(on.prefix.breakAt);
		});

		it(`G3 noticeRepeats: a notice on every request in the zone, right before each cut (fixture seed ${seed})`, async () => {
			const r = await run(seed, true);
			report("p4", ENGINE_LABEL, `repeats.${seed}`, {
				requests: r.model.requests.length,
				cuts: r.stats.cuts.length,
				requestsWithNotice: r.withNotice.length,
				noticesPerCycle: r.cycles,
				cutsWithNoticeRightBefore: r.cutsWithNoticeRightBefore,
				idealPrefixShare: +r.prefix.idealPrefixShare.toFixed(3),
			});
			expect(r.withNotice.length).toBeGreaterThan(r.breaks.length);
			expect(r.misplaced).toBe(0);
			expect(r.persisted).toBe(false);
			expect(r.cutsWithNoticeRightBefore).toBe(r.breaks.length);
		});

		it(`notice once per cut cycle, at the tail only, never persisted, prefix stable (fixture seed ${seed})`, async () => {
			const r = await run(seed);
			const { stats, model, withNotice, prefix } = r;
			const rawPrefix = analyzePrefixes(model.requests);
			const sample = model.requests[withNotice[0] ?? 0]?.at(-1);
			report("p4", ENGINE_LABEL, `mode-a.${seed}`, {
				requests: model.requests.length,
				cuts: stats.cuts.length,
				requestsWithNotice: withNotice.length,
				noticesPerCycle: r.cycles,
				misplaced: r.misplaced,
				persisted: r.persisted,
				prefixBreaksIgnoringNotice: prefix.breaks,
				prefixBreaksRaw: rawPrefix.breaks,
				idealPrefixShare: +prefix.idealPrefixShare.toFixed(3),
				idealPrefixShareRaw: +rawPrefix.idealPrefixShare.toFixed(3),
				cutsWithNoticeInCycle: r.cutsWithNoticeInCycle,
				cutsWithNoticeRightBefore: r.cutsWithNoticeRightBefore,
				violations: model.requests.flatMap((m) => validateRequest(m)).length,
				sample: sample ? JSON.parse(sample).content : undefined,
			});
			expect(withNotice.length).toBeGreaterThan(0);
			expect(r.misplaced).toBe(0);
			expect(r.persisted).toBe(false);
			expect(prefix.breaks).toBe(stats.cuts.length);
			// G3: at most one notice per cut cycle, and every cut was announced within its cycle.
			expect(Math.max(...r.cycles)).toBeLessThanOrEqual(1);
			expect(r.cutsWithNoticeInCycle).toBe(r.breaks.length);
			expect(model.requests.flatMap((m) => validateRequest(m))).toEqual([]);
			expect(sample).toContain("src/module-");

			// Anthropic: build the real payload Pi would send for a request that carries a notice (Pi's own
			// converter, no network), and check where the prompt-cache breakpoint lands.
			const request = model.requests[withNotice[0]].map((m) => JSON.parse(m) as Message);
			const claude = {
				id: "claude-test",
				name: "claude-test",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.invalid",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			} as unknown as Model<"anthropic-messages">;
			let payload: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> } | undefined;
			const stream = anthropicStreamSimple(claude, { messages: request } as never, {
				apiKey: "test",
				onPayload: (p) => {
					payload = p as typeof payload;
					return p;
				},
				fetch: async () => {
					throw new Error("offline");
				},
			});
			await stream.result();
			const breakpoints = (p: typeof payload) =>
				(p?.messages ?? []).flatMap((m, i) =>
					m.content.flatMap((b, j) =>
						b.cache_control ? [{ message: i, block: j, notice: String(b.text ?? "").includes(MARKER) }] : [],
					),
				);
			// The breakpoint lands on the notice (the reason the notice ships off; the prototype's cache surgery
			// that moved it is not ported).
			const before = breakpoints(payload);
			report("p4", ENGINE_LABEL, `anthropic-breakpoint.${seed}`, { before });
			expect(before.some((b) => b.notice)).toBe(true);
		});
	}
});
