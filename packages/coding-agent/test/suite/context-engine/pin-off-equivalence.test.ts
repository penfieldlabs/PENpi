/**
 * With the pin off and the notice on, the engine is request-for-request the reference engine
 * (reference/p2-context-engine.ts, whose defaults are pin off, notice on), so the pin and the notice's
 * defaults are the only behaviour they add. The same scripted sessions run through both; every provider
 * request must be identical: the messages as serialized for the provider (header text included), the
 * number of requests, and the engine's cut records. Entry ids are deterministic (deterministic-ids.ts) and
 * restart for each run; they are also canonicalized (numbered in order of first appearance) before the
 * comparison; nothing else is normalized.
 *
 * Paths covered (asserted, so the comparison is not vacuous): context cuts and overflow recovery.
 */

import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as P2 from "../../../../../.pi/extensions/penpi/engine/index.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import {
	finalTurn,
	installProviderSim,
	rng,
	scriptedModel,
	serializeForProvider,
	toolTurn,
	workExtension,
} from "./helpers.ts";
import * as P1 from "./reference/p2-context-engine.ts";

type Engine = typeof P2 | typeof P1;
type Mode = "a";

interface Trace {
	/** Per provider request: sha256 of its canonicalized messages (memory: no full copies are kept). */
	requests: string[];
	/** The canonicalized text of every request, kept only when KEEP_TEXT is set (debugging a mismatch). */
	texts: string[];
	cuts: Array<{ seq: number; mode: string; where: string; omitted: number; before: number; after: number }>;
	guardTrims: number;
	overflowRetries: number;
	capped: number;
}

/** Entry ids (8 hex) made by Pi are random per run: number them by first appearance within the run. */
function canonicalizer(): (s: string) => string {
	const ids = new Map<string, string>();
	return (s: string) =>
		s.replace(/\b[0-9a-f]{8}\b/g, (id) => {
			if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
			return ids.get(id)!;
		});
}

describe("pin off, notice on is byte-identical to the reference engine (reference/p2-context-engine.ts)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(engine: Engine, mode: Mode, script: "cuts" | "overflow"): Promise<Trace> {
		const stats = engine.newStats();
		resetEntryIds();
		// The harness names its working directory from Date.now() and Math.random(), and the directory is in
		// the system prompt (and so in the engine's token estimates). Fix both while the harness is created so
		// the two runs see the same directory; the first run's harness is removed before the second starts.
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_791_900_000_000);
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		let harness: Harness;
		try {
			harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					// p3 persists one state entry per user message at its message_end (the input source, A1), which
					// takes one id from Pi's id sequence. The p2 run gets the same entry from a shim at the same
					// event, so entry ids (which appear in headers and estimates) line up; custom entries never reach
					// the provider.
					...(engine === P2
						? []
						: [
								(pi: ExtensionAPI) =>
									pi.on(
										"message_end",
										(e) => void (e.message.role === "user" && pi.appendEntry("equiv-shim", {})),
									),
							]),
					engine.createContextEngine({
						mode,
						stats,
						// p3 in the p2 configuration (no-ops for p2, whose defaults these are).
						...(engine === P2 ? { pinUserMessages: null, notice: true } : {}),
					} as never),
				],
			});
		} finally {
			clock.mockRestore();
			random.mockRestore();
		}
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// Deterministic usage: the faux provider's own usage splits prompt tokens into cache read/write by its
		// cache state, and the rounding of that split varies by a token between runs (seen as a 1-token
		// difference in a notice when p1 was compared with itself), which moves the engine's calibration.
		installProviderSim(harness);
		const model = scriptedModel(harness, 4_000, { digest: true });
		// Record every provider request as the provider would see it (outermost wrapper: after the engine).
		const canon = canonicalizer();
		const requests: string[] = [];
		const texts: string[] = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, options) => {
			const text = context.messages.map((msg) => canon(serializeForProvider(msg as Message))).join("\n\u0000\n");
			requests.push(createHash("sha256").update(text).digest("hex"));
			if (process.env.KEEP_TEXT) texts.push(text);
			return inner(m, context, options);
		};
		if (script === "cuts") {
			// Steady growth over several prompts: several cuts.
			const next = rng(11);
			for (let p = 0; p < 5; p++) {
				for (let t = 0; t < 20; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), p * 100 + t));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`Task ${p}: look at the material and report back on every part of it.`);
			}
		} else {
			// Overflow recovery: one request fails with an overflow error mid-turn; the engine recovers.
			let calls = 0;
			const original = harness.session.agent.streamFunction;
			harness.session.agent.streamFunction = async (m, context, options) => {
				if (calls++ === 9) {
					const stream = createAssistantMessageEventStream();
					const error = fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage: "Your input exceeds the context window of this model",
					});
					Object.assign(error, { provider: m.provider, model: m.id, api: m.api });
					queueMicrotask(() => {
						stream.push({ type: "error", reason: "error", error });
						stream.end(error);
					});
					return stream;
				}
				return original(m, context, options);
			};
			for (let t = 0; t < 24; t++) model.push(toolTurn(3_000, 900 + t));
			model.push(finalTurn("answer after retry"));
			await harness.session.prompt("Do the long job.");
		}
		if (process.env.EQUIV_DUMP)
			(await import("node:fs")).writeFileSync(
				`${process.env.EQUIV_DUMP}.${engine === P2 ? "p3" : "p2"}.json`,
				JSON.stringify({ sent: stats.sent, samples: stats.calibrationSamples }),
			);
		harness.cleanup();
		harnesses.splice(harnesses.indexOf(harness), 1);
		return {
			requests,
			texts,
			cuts: stats.cuts,
			guardTrims: stats.guardTrims,
			overflowRetries: stats.overflowRetries,
			capped: stats.capped,
		};
	}

	// Each scenario asserts that it exercised its path, so the comparison is never vacuous and each can run
	// alone (the gate runs them one process at a time on a small box).
	const SCENARIOS: Array<{
		mode: Mode;
		script: "cuts" | "overflow";
		path: string;
		hit: (t: Trace) => number;
	}> = [
		{ mode: "a", script: "cuts", path: "context cuts", hit: (t) => t.cuts.length },
		{ mode: "a", script: "overflow", path: "overflow recovery", hit: (t) => t.overflowRetries },
	];

	for (const { mode, script, path, hit } of SCENARIOS) {
		it(`mode ${mode}, ${script} (${path}): every request identical to the reference engine (pin off, notice on)`, async () => {
			const p1 = await run(P1, mode, script);
			// EQUIV_SAME=1 compares p1 with itself (a check that the scenario is deterministic).
			const p2 = await run(process.env.EQUIV_SAME ? P1 : P2, mode, script);
			expect(p2.requests.length).toBe(p1.requests.length);
			const first = p1.requests.findIndex((h, i) => p2.requests[i] !== h);
			const at = (x: string, y: string) => {
				let k = 0;
				while (k < x.length && x[k] === y[k]) k++;
				return `char ${k}:\np1 …${x.slice(Math.max(0, k - 200), k + 300)}\np2 …${y.slice(Math.max(0, k - 200), k + 300)}`;
			};
			expect(
				first,
				first >= 0 && p1.texts.length
					? `request ${first}, ${at(p1.texts[first], p2.texts[first])}`
					: `first differing request ${first} (rerun with KEEP_TEXT=1)`,
			).toBe(-1);
			expect(p2.cuts).toEqual(p1.cuts);
			expect(p2.guardTrims).toBe(p1.guardTrims);
			expect(p2.overflowRetries).toBe(p1.overflowRetries);
			expect(p2.capped).toBe(p1.capped);
			expect(hit(p1), `${path} exercised`).toBeGreaterThan(0);
		});
	}
});
