/**
 * R5: silent-truncation detection without a plateau. Between two consecutive requests whose message
 * list only grew, reported usage must grow by about what was appended (text only). A sample that does
 * not is quarantined (it never moves the ratio); one with no growth at all is strong evidence, others
 * need a second. Both server styles: one that reports exactly its limit (fills its context) and one
 * that drops whole old messages and reports the real remainder. Detection within 3 truncated requests;
 * no detection on an honest provider whatever the content, images, model switches and cuts.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import {
	blobExtension,
	finalTurn,
	installProviderSim,
	type ProviderSim,
	report,
	runPrompts,
	scriptedModel,
	syntheticText,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const SCENARIOS = [
	{
		label: "64k model, server holds 24k, 1-5k-character results",
		model: { id: "srv-64k", contextWindow: 64_000, maxTokens: 8_000 },
		silentLimit: 24_000,
		run: { prompts: 6, turns: 25 },
	},
	{
		label: "32k model, server holds 16k, 2-20k-character results (cuts break any chain)",
		model: { id: "srv-32k", contextWindow: 32_000, maxTokens: 4_000 },
		silentLimit: 16_000,
		run: { prompts: 6, turns: 25, min: 2_000, spread: 18_000 },
	},
	{
		label: "1M model at the 200k ceiling, server holds 100k, slow growth (1-3k-character results)",
		model: { id: "srv-1m", contextWindow: 1_048_576, maxTokens: 65_536 },
		silentLimit: 100_000,
		run: { prompts: 10, turns: 30, min: 1_000, spread: 2_000 },
	},
];

describe("silent truncation without a plateau", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const scenario of SCENARIOS) {
		for (const silentReport of ["limit", "remainder"] as const) {
			it(`detects within 3 truncated requests: ${scenario.label}, server reports ${silentReport === "limit" ? "its limit" : "what it kept"}`, async () => {
				const stats = newStats();
				const lines: string[] = [];
				let sim: ProviderSim | undefined;
				let detectedAtCall: number | undefined;
				const harness = await createHarness({
					models: [scenario.model],
					settings: { compaction: { enabled: false } },
					extensionFactories: [
						workExtension,
						createContextEngine({
							stats,
							log: (line) => {
								lines.push(line);
								// At message_end of call k the simulator has recorded k + 1 calls.
								if (detectedAtCall === undefined && line.includes("silent truncation:"))
									detectedAtCall = sim?.calls.length;
							},
						}),
					],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				sim = installProviderSim(harness, { silentLimit: scenario.silentLimit, silentReport });
				const model = scriptedModel(harness);
				await runPrompts(harness, model, scenario.run);
				const truncated = sim.calls.flatMap((c, i) => (c.truncatedInput ? [i] : []));
				const lag = detectedAtCall === undefined ? null : truncated.filter((i) => i < detectedAtCall!).length;
				report("r5", ENGINE_LABEL, `detect.${scenario.model.id}.${silentReport}`, {
					truncated: truncated.length,
					truncatedAt: truncated,
					detectedAtCall,
					lag,
					learned: stats.plateaus,
					evidence: lines.filter((l) => l.includes("silent truncation")),
					cuts: stats.cuts.length,
				});
				expect(truncated.length).toBeGreaterThan(0);
				expect(stats.plateaus).toHaveLength(1);
				expect(lag).not.toBeNull();
				// p4: one strong sample acts again, so the bar is 3 in every scenario (p3's confirmation rule needed 5
				// for the 32k model with a server that reports what it kept).
				expect(lag!).toBeLessThanOrEqual(3);
				expect(truncated.length).toBe(lag);
				expect(stats.plateaus[0].window).toBeLessThanOrEqual(scenario.silentLimit);
			});
		}
	}

	it("no detection on an honest provider: density shifts, images, separator lines, a model switch, warm-up", async () => {
		const stats = newStats();
		const lines: string[] = [];
		const zh = readFileSync(new URL("./samples/zh.txt", import.meta.url), "utf8");
		const screenshot = readFileSync(new URL("../../../docs/images/doom-extension.png", import.meta.url)).toString(
			"base64",
		);
		// Six content kinds, every result distinct (a seed per use), sizes varying.
		const makers: Array<(i: number) => { text?: string; images?: Array<{ data: string; mimeType: string }> }> = [
			(i) => ({ text: syntheticText(4_000 + (i % 7) * 1_500, 100 + i) }),
			(i) => ({ text: `${i}: ${zh.repeat(4).slice(i % 50, (i % 50) + 3_000 + (i % 5) * 600)}` }),
			(i) => ({ text: randomBytes(2_000 + (i % 6) * 700).toString("base64") }),
			(i) => ({ text: `${i}\n${`${"-".repeat(80 + (i % 40))}\n${"=".repeat(120)}\n`.repeat(20 + (i % 30))}` }),
			(i) => ({ text: Array.from({ length: 600 + (i % 9) * 150 }, (_, k) => String((k + i) * 7919)).join(" ") }),
			(i) => ({
				text: `screenshots ${i}`,
				images: Array.from({ length: 1 + (i % 2) }, () => ({ data: screenshot, mimeType: "image/png" })),
			}),
		];
		const blobs: Record<string, { text?: string; images?: Array<{ data: string; mimeType: string }> }> = {};
		for (let i = 0; i < 260; i++) blobs[`b${i}`] = makers[i % makers.length](i);

		const harness = await createHarness({
			models: [
				{ id: "honest-a", contextWindow: 48_000, maxTokens: 4_000 },
				{ id: "honest-b", contextWindow: 48_000, maxTokens: 4_000 },
			],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				blobExtension(blobs),
				workExtension,
				createContextEngine({ stats, log: (line) => lines.push(line) }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// The provider counts honestly but differently per model (a dense and a sparse tokenizer) and
		// barely counts images (faux text placeholders), so the engine's estimate swings around it.
		installProviderSim(harness, { scale: (m) => (m.id === "honest-a" ? 1.7 : 0.8) });
		const model = scriptedModel(harness);
		let n = 0;
		for (const id of ["honest-a", "honest-b", "honest-a"]) {
			await harness.session.setModel(harness.getModel(id)!);
			for (let p = 0; p < 3; p++) {
				for (let t = 0; t < 24; t++) {
					const kind = `b${n++}`;
					model.push(() =>
						fauxAssistantMessage([fauxToolCall("blob", { name: kind }, { id: `blob-${n}` })], {
							stopReason: "toolUse",
						}),
					);
					if (t % 5 === 0) model.push(toolTurn(3_000, n));
				}
				model.push(finalTurn(`done ${id} ${p}`));
				await harness.session.prompt(`Look at the material, part ${p}.`);
			}
		}
		report("r5", ENGINE_LABEL, "honest", {
			cuts: stats.cuts.length,
			samples: stats.calibrationSamples.length,
			sampleRange: [Math.min(...stats.calibrationSamples), Math.max(...stats.calibrationSamples)],
			detections: stats.plateaus,
			evidence: lines.filter((l) => l.includes("silent truncation")),
		});
		expect(stats.cuts.length).toBeGreaterThan(5);
		expect(stats.plateaus).toHaveLength(0);
	});
});
