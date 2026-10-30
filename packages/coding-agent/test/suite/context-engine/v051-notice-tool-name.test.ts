/**
 * 0.5.1: the pre-cut notice lists the tools of the messages that will leave view. A stored tool call whose name
 * is not a string (a broken provider reply, as RC6 repairs in the request) must not stop the engine: the notice
 * skips such a call, as repair.ts treats a blank name, instead of throwing on `name.trim()`.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, rng, scriptedModel, workExtension } from "./helpers.ts";

const MARKER = "[context-engine notice]";

describe("0.5.1: the pre-cut notice with a tool call that has no string name", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("v051 a call whose name is not a string: the engine gives the notice and cuts, with no engine error", async () => {
		resetEntryIds();
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, notice: true, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness);

		// The first reply carries a tool call with no string name, as a broken provider reply would be stored.
		const broken = fauxToolCall("work", { size: 40, seed: 0 }, { id: "call-broken" });
		(broken as { name: unknown }).name = undefined;
		model.push(() => fauxAssistantMessage([fauxText("Looking."), broken], { stopReason: "toolUse" }));
		// Then several prompts of work (the engine cuts at a turn boundary), with the broken call among what leaves.
		const next = rng(51);
		let s = 1;
		for (let p = 0; p < 5; p++) {
			for (let t = 0; t < 12; t++, s++) {
				const step = s;
				const size = 1_000 + Math.floor(next() * 3_000);
				model.push(() =>
					fauxAssistantMessage(
						[
							fauxText(`Step ${step}.`),
							fauxToolCall("work", { size, seed: step, path: `src/m-${step}.ts` }, { id: `call-${step}` }),
						],
						{ stopReason: "toolUse" },
					),
				);
			}
			model.push(finalTurn(`Done ${p}.`));
			await harness.session.prompt(p === 0 ? "Work through the modules." : `Next batch ${p}.`);
		}

		expect(lines.filter((l) => l.includes("context_with_system error"))).toEqual([]);
		expect(model.requests.some((r) => r.some((m) => m.includes(MARKER)))).toBe(true);
		expect(stats.cuts.length).toBeGreaterThan(0);
	});
});
