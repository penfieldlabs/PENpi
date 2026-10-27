/**
 * Behaviours without a test, item 7 (H3 variant): a window learned from an overflow error that states no
 * number ("unparsed") is re-probed after probeAfterUnparsed (8) clean requests near it, and retired when a
 * request above the rejected size succeeds.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { installProviderSim, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const NUMBERLESS =
	"botocore.errorfactory.ValidationException: An error occurred (ValidationException) when calling the InvokeModel operation: Input is too long for requested model.";

describe("H3: re-probe of an unparsed learned window", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("b07 one number-less overflow: the window is learned unparsed, re-probed after 8 clean requests, and retired", async () => {
		const stats = newStats();
		const lines: string[] = [];
		// The number of provider calls made when each log line was written.
		const callsAtLine: number[] = [];
		let callsSoFar = () => 0;
		const harness = await createHarness({
			models: [{ id: "router-64k", contextWindow: 64_000, maxTokens: 8_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({
					stats,
					log: (l) => {
						lines.push(l);
						callsAtLine.push(callsSoFar());
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let badRouteUsed = false;
		const sim = installProviderSim(harness, {
			// One bad route, once: the first request above 33,000 tokens (over half the window) is rejected.
			realLimit: (_i, tokens) => {
				if (!badRouteUsed && tokens > 33_000) {
					badRouteUsed = true;
					return 33_000;
				}
				return 64_000;
			},
			overflowMessage: () => NUMBERLESS,
		});
		callsSoFar = () => sim.calls.length;
		await runPrompts(harness, scriptedModel(harness), { prompts: 12, turns: 25 });

		expect(sim.calls.filter((c) => c.rejected)).toHaveLength(1);
		expect(stats.learnedWindows[0]?.source).toBe("unparsed");
		const learned = stats.learnedWindows[0].window;
		expect(learned).toBeLessThan(33_000);
		// The re-probe starts after 8 clean requests near the learned window, and the window is retired.
		expect(lines.some((l) => l.includes(`probe: ${learned} -> `))).toBe(true);
		expect(stats.probes[0]?.from).toBe(learned);
		expect(lines.some((l) => l.includes("(learned window retired)"))).toBe(true);
		expect(stats.lastLimits?.window).toBe(64_000);
		const rejectedAt = sim.calls.findIndex((c) => c.rejected);
		const probeLine = lines.findIndex((l) => l.includes(`probe: ${learned} -> `));
		expect(probeLine).toBeGreaterThan(0);
		// At least 8 accepted requests passed between the rejection and the probe (counted up to the probe,
		// not to the end of the session).
		const probeCall = callsAtLine[probeLine];
		expect(probeCall).toBeGreaterThan(rejectedAt + 1);
		const beforeProbe = sim.calls.slice(rejectedAt + 1, probeCall).filter((c) => !c.rejected);
		expect(beforeProbe.length).toBeGreaterThanOrEqual(8);
		// Exactly 8 of them were near the learned window (usage of at least half of it): the eighth started
		// the probe.
		expect(beforeProbe.filter((c) => c.processedTokens >= 0.5 * learned)).toHaveLength(8);
	});
});
