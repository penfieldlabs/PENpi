/**
 * 0.9.0, ADR 0035: the exact-repeat rule within its allowance (silentEstimateError), at session level. A server that
 * fills its context reports exactly its limit, so a sample that reports exactly the largest usage reported so far
 * again is evidence when its request was expected above that, or below it within the allowance: E2's
 * data.o200k.32k.silent-front on the v1.5.1 corpus, call 12 (expected 0.963 of the maximum).
 *
 * The server holds 20,000 tokens and reports exactly that for a larger request. Each request that crosses the limit is
 * aimed at a target in the provider's tokens; the first crossing sets the largest usage reported, the second reports
 * it again expected above it (evidence by the rule as before), and the third is expected below it but counted above
 * it by the provider (a denser count, `extra`): exactly the maximum again, expected within the allowance below it.
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	type ProviderSim,
	scriptedModel,
	syntheticText,
	workExtension,
} from "./helpers.ts";

interface Plan {
	chars: number;
	/** Tokens added to what the provider counts for this call (a denser count). */
	extra?: number;
}

const LIMIT = 20_000;
const harnesses: Harness[] = [];

/** Faux-token targets of the crossings; `extra` pushes a crossing over the limit by the provider's count. */
async function crossings(targets: Array<{ at: number; extra?: number }>, engine: Record<string, unknown> = {}) {
	const stats = newStats();
	const rows: Array<{ call: number; line: string }> = [];
	let sim: ProviderSim | undefined;
	const plans: Plan[] = [];
	const harness = await createHarness({
		models: [{ id: "srv", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			createContextEngine({
				stats,
				...engine,
				log: (line: string) => rows.push({ call: (sim?.calls.length ?? 0) - 1, line }),
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	sim = installProviderSim(harness, {
		servedBy: (index) => {
			const extra = plans[index]?.extra ?? 0;
			return { holds: LIMIT, ...(extra !== 0 ? { offset: -extra } : {}) };
		},
	});
	const model = scriptedModel(harness);
	let next = 0;
	let phase: "regrow" | "big" = "regrow";
	for (let turn = 0; turn < 70; turn++)
		model.push(() => {
			const calls = sim!.calls;
			const last = calls.at(-1)?.promptTokens ?? 0;
			let plan: Plan;
			const target = targets[next];
			if (phase === "big") {
				// Over the limit by far, so the engine cuts and the next crossing starts from a regrow.
				phase = "regrow";
				plan = { chars: 32_000 };
			} else if (target && last >= 14_000) {
				next++;
				phase = "big";
				plan = { chars: Math.max(400, (target.at - last - 15) * 4), extra: target.extra };
			} else plan = { chars: !target && last >= 14_000 ? 160 : 4_000 };
			// The request after this answer carries its result.
			plans[calls.length] = plan;
			return fauxAssistantMessage(
				[fauxText(`Step ${turn}.`), fauxToolCall("work", { size: plan.chars, seed: turn }, { id: `call-${turn}` })],
				{ stopReason: "toolUse" },
			);
		});
	model.push(finalTurn("done"));
	await harness.session.prompt(`First task: ${syntheticText(1_600, 99).replace(/\s+/g, " ")}`);
	const detectedAt = rows.find((r) => r.line.includes("silent truncation: ") && r.line.includes("window ->"))?.call;
	const at = plans.flatMap((p, i) => (p && p.chars !== 32_000 && p.chars !== 4_000 && p.chars !== 160 ? [i] : []));
	return {
		rows,
		detectedAt,
		at,
		reportedAt: at.map((i) => sim!.calls[i].processedTokens),
	};
}

describe("0.9.0, ADR 0035: the exact repeat within the allowance, at session level", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("the third crossing, expected about 2% below the maximum, completes the evidence: detection there; at 0, one later", async () => {
		// The fourth is above the maximum, and more than 0.5% from the first crossing's expected size.
		const targets = [{ at: 20_300 }, { at: 20_700 }, { at: 19_500, extra: 600 }, { at: 20_150 }];
		const on = await crossings(targets);
		expect(on.reportedAt.slice(0, 3)).toEqual([LIMIT, LIMIT, LIMIT]);
		expect(on.detectedAt).toBe(on.at[2]);
		// The log shows what the rule compared.
		const third = on.rows.find(
			(r) => r.call === on.at[2] && r.line.includes("reported exactly the previous maximum"),
		);
		expect(third?.line).toMatch(/expected about \d+ \(accepted from 19000 to 32000\)/);
		const off = await crossings(targets, { silentEstimateError: 0 });
		expect(off.detectedAt).toBe(off.at[3]);
	});

	it("its lower edge: a crossing expected 6% below the maximum is no evidence: detection waits for the next", async () => {
		const below = await crossings([{ at: 20_300 }, { at: 20_700 }, { at: 18_500, extra: 1_600 }, { at: 20_150 }]);
		expect(below.reportedAt[2]).toBe(LIMIT);
		expect(below.detectedAt).toBe(below.at[3]);
	});
});
