/**
 * 0.6.0, D24's notice gap (design 4 of 060-designs.md): the silent-truncation check compares the usage the provider
 * reports with what each request appended. The request that carries the pre-cut notice appends the notice too, and
 * the provider counts it; the check must count it as well. Small appends (about 150 tokens) make a missing notice
 * (about 100 tokens) a large error, so an honest provider must read as honest, request by request.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, workExtension } from "./helpers.ts";

describe("0.6.0: the growth check counts the request's own pre-cut notice (D24 notice gap)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("v060 an honest provider: every judged sample's expected growth matches its reported growth, the notice request included", async () => {
		resetEntryIds();
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, notice: true, noticeFraction: 0.5 })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		installProviderSim(harness, {});
		const model = scriptedModel(harness);
		for (let i = 0; i < 200 && stats.notices === 0; i++) {
			model.push(
				() =>
					fauxAssistantMessage(
						[fauxText(`Step ${i}.`), fauxToolCall("work", { size: 120, seed: i }, { id: `w-${i}` })],
						{
							stopReason: "toolUse",
						},
					),
				finalTurn(`done ${i}`),
			);
			await harness.session.prompt(`Batch ${i}.`);
		}
		expect(stats.notices, "a notice was given").toBeGreaterThan(0);
		// The request after the notice drops it again (the previous request's notice).
		model.push(finalTurn("one more"));
		await harness.session.prompt("One more batch.");
		expect(stats.cuts, "no cut in between").toHaveLength(0);

		// The request that ends with the notice, and its growth check (request i is the engine's send i + 1).
		const at = model.requests.findIndex((r) => r.at(-1)?.includes("[context-engine notice]"));
		expect(at, "a request carried the notice").toBeGreaterThan(0);
		const notice = stats.growthChecks.find((c) => c.seq === at + 1);
		expect(notice, "the notice request was judged").toBeDefined();
		// Its neighbours of the same kind (the tool-result step of each batch, the largest appends) set the usual
		// ratio between the engine's estimate and this provider's count; the notice request must read the same.
		const steps = stats.growthChecks.filter((c) => c.seq !== notice!.seq && c.delta >= 30);
		const ratios = steps.map((c) => c.grow / c.delta).sort((a, b) => a - b);
		const usual = ratios[Math.floor(ratios.length / 2)];
		const own = notice!.grow / notice!.delta;
		if (process.env.D24_SHOW)
			console.log(
				`notice ${Math.round(notice!.grow)}/${notice!.delta} usual ${usual.toFixed(2)} own ${own.toFixed(2)}`,
			);
		// Measured: without the fix the notice request reads 51 of 116 (0.44 against a usual 1.09, 60% off); with it,
		// 106 of 116 (16% off: the estimator reads the notice's prose a little differently from these short texts).
		// The design's "within 5%" assumes a calibrated count, which the faux texts here do not give.
		expect(Math.abs(own - usual) / usual, "the notice request against the usual ratio").toBeLessThan(0.3);
	});
});
