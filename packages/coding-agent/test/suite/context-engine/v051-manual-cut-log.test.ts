/**
 * 0.5.1: a manual /compact advances the window with a cut, and the engine log names it as it names every other
 * cut: `cut #N (manual) at <index> entry=<id> <before> -> <after> (budget <b>, ratio <r>)`.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, workExtension } from "./helpers.ts";

describe("0.5.1: a manual cut is logged", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("v051 /compact logs a cut #N (manual) line with the cut's numbers", async () => {
		resetEntryIds();
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			// A small keepRecentTokens: Pi hands /compact to the engine only when the session is larger than that.
			settings: { compaction: { enabled: false, keepRecentTokens: 1_000 } },
			extensionFactories: [workExtension, createContextEngine({ stats, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness);
		// Three short prompts: well under the cut threshold, so only the manual cut moves the window.
		for (let p = 0; p < 3; p++) {
			for (let s = 0; s < 3; s++) {
				const step = p * 3 + s;
				model.push(() =>
					fauxAssistantMessage(
						[fauxText(`Step ${step}.`), fauxToolCall("work", { size: 600, seed: step }, { id: `call-${step}` })],
						{ stopReason: "toolUse" },
					),
				);
			}
			model.push(finalTurn(`Done ${p}.`));
			await harness.session.prompt(`Task ${p}`);
		}
		expect(stats.cuts).toHaveLength(0);

		const compactError = await harness.session.compact().then(
			() => "",
			(e: Error) => e.message,
		);
		expect(compactError).not.toMatch(/Nothing to compact/);

		expect(stats.cuts).toHaveLength(1);
		expect(stats.cuts[0]).toMatchObject({ seq: 1, where: "manual" });
		const cutLines = lines.filter((l) => /\bcut #\d+/.test(l));
		expect(cutLines).toHaveLength(1);
		expect(cutLines[0]).toMatch(
			/^\[a\] cut #1 \(manual\) at \d+ entry=\S+ \d+ -> \d+ \(budget \d+, ratio \d+\.\d{3}\)$/,
		);
		// The numbers are the cut's: it starts where the cut entry says, and the window shrinks.
		const [, at, before, after] = cutLines[0].match(/ at (\d+) entry=\S+ (\d+) -> (\d+)/)!;
		expect(Number(at)).toBe(stats.cuts[0].omitted);
		expect(Number(after)).toBeLessThan(Number(before));
	});
});
