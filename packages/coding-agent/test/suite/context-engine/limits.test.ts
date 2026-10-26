/**
 * E7: effective limits for unverified model metadata, and the output clamp in before_provider_request.
 */
import { writeFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	LOG_DIR,
	logger,
	rng,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const results: Record<string, unknown> = {};

async function workload(harness: Harness, prompts: number) {
	const model = scriptedModel(harness);
	const next = rng(9);
	let seed = 0;
	for (let p = 0; p < prompts; p++) {
		for (let t = 0; t < 19; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), seed++));
		model.push(finalTurn(`done ${p}`));
		await harness.session.prompt(`Task ${p}`);
	}
	return model;
}

describe("context engine: effective limits", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/limits.json`, JSON.stringify(results, null, 2));
	});

	it("clamps the requested output when maxTokens is implausible (above 0.75 of the window)", async () => {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-bigmax", contextWindow: 32_000, maxTokens: 30_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, log: logger("limits.log") })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness);
		await workload(harness, 2);
		const sent = sim.calls.map((c) => c.maxTokens ?? 0);
		results.unverifiedMaxTokens = {
			maxTokensSent: [Math.min(...sent), Math.max(...sent)],
			clamped: stats.clampedOutput,
			maxPrompt: Math.max(...sim.calls.map((c) => c.promptTokens)),
		};
		// Round 2 (H4): implausible metadata gets the 16,384 default, capped at half the window.
		expect(Math.max(...sent)).toBeLessThanOrEqual(16_000);
		expect(stats.clampedOutput).toBeGreaterThan(0);
	});

	it("applies an override map (window and output)", async () => {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-ovr", contextWindow: 200_000, maxTokens: 32_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({
					stats,
					limitOverrides: { "faux/faux-ovr": { contextWindow: 16_000, maxTokens: 2_000 } },
					log: logger("limits.log"),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness);
		await workload(harness, 2);
		results.override = {
			maxPrompt: Math.max(...sim.calls.map((c) => c.promptTokens)),
			maxTokensSent: Math.max(...sim.calls.map((c) => c.maxTokens ?? 0)),
			cuts: stats.cuts.length,
		};
		expect(Math.max(...sim.calls.map((c) => c.promptTokens))).toBeLessThanOrEqual(16_000);
		expect(Math.max(...sim.calls.map((c) => c.maxTokens ?? 0))).toBeLessThanOrEqual(2_000);
	});

	it("treats a model missing from the registry as unverified and uses the default window", async () => {
		const stats = newStats();
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({ stats, defaultWindow: 24_000, log: logger("limits.log") }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// A model object the registry does not know (e.g. built by another extension at runtime).
		const unregistered: Model<string> = {
			...harness.getModel(),
			id: "unregistered-x",
			contextWindow: 200_000,
			maxTokens: 8_000,
		};
		harness.session.agent.state.model = unregistered;
		const sim = installProviderSim(harness);
		await workload(harness, 2);
		results.unregistered = {
			selected: harness.session.model?.id,
			maxPrompt: Math.max(...sim.calls.map((c) => c.promptTokens)),
			cuts: stats.cuts.length,
			piContextWindow: harness.session.getContextUsage()?.contextWindow,
		};
		expect(harness.session.model?.id).toBe("unregistered-x");
		expect(Math.max(...sim.calls.map((c) => c.promptTokens))).toBeLessThanOrEqual(24_000);
	});

	it("reports what upstream sends for a model with neither window nor maxTokens", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-zero", contextWindow: 0, maxTokens: 0 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ log: logger("limits.log") })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness);
		const model = scriptedModel(harness);
		model.push(finalTurn("hi"));
		await harness.session.prompt("hello");
		results.zeroMetadata = { maxTokensSentByProvider: sim.calls[0]?.maxTokens };
		// Upstream clampMaxTokensToContext yields max(1, 0) = 1; the engine only lowers, never raises,
		// because cache-warming requests legitimately send max_tokens 1 through the same hook.
		expect(sim.calls[0]?.maxTokens).toBe(1);
	});
});
