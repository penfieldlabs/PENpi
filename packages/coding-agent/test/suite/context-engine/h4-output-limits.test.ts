/**
 * H4: output limits. The provider simulator honors the payload's max_tokens (a length stop at that
 * many output tokens) and, where set, its own real output ceiling.
 */
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	logger,
	report,
	scriptedModel,
	syntheticText,
	writeFileExtension,
} from "./helpers.ts";

/** The model keeps re-issuing the write until a write_file result succeeds (at most `attempts` times). */
function writeUntilDone(path: string, chars: number, attempts: number) {
	const content = syntheticText(chars, 4242);
	const lastResultOk = (context: TranscriptContext) => {
		const last = context.messages.at(-1);
		return last?.role === "toolResult" && last.toolName === "write_file" && !last.isError;
	};
	return Array.from(
		{ length: attempts },
		() => (context: TranscriptContext) =>
			lastResultOk(context)
				? fauxAssistantMessage("written")
				: fauxAssistantMessage([fauxToolCall("write_file", { path, content })], { stopReason: "toolUse" }),
	);
}

const MODELS = {
	"o3-like (200k / 100k)": { id: "o3-like", contextWindow: 200_000, maxTokens: 100_000 },
	"GLM-5.3-Flash fallback (262,144 / 262,144)": { id: "glm-fallback", contextWindow: 262_144, maxTokens: 262_144 },
	"GLM-5.3-Flash refreshed (1,048,575 / 943,717)": {
		id: "glm-refreshed",
		contextWindow: 1_048_575,
		maxTokens: 943_717,
	},
};

describe("H4: output limits", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const [label, definition] of Object.entries(MODELS)) {
		it(`h4 tool call above 4k output tokens succeeds: ${label}`, async () => {
			const stats = newStats();
			const writes: Array<{ path: string; chars: number }> = [];
			const harness = await createHarness({
				models: [definition],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					writeFileExtension(writes),
					createContextEngine({ stats, log: logger(`h4.${ENGINE_LABEL}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			// A provider that really allows 32k output tokens, whatever the metadata says.
			const sim = installProviderSim(harness, { honorMaxTokens: true, outputCeiling: 32_768 });
			const model = scriptedModel(harness);
			model.push(...writeUntilDone("src/big.ts", 80_000, 4), finalTurn("done"));
			await harness.session.prompt("Write src/big.ts.");
			report("h4", ENGINE_LABEL, `tool-call.${definition.id}`, {
				writes: writes.length,
				attempts: sim.calls.filter((c) => c.lengthStop).length + writes.length,
				maxTokensSent: sim.calls.map((c) => c.maxTokens),
				outputTokens: sim.calls.map((c) => c.outputTokens),
			});
			expect(writes).toHaveLength(1);
			expect(sim.calls.filter((c) => c.lengthStop).length).toBeLessThanOrEqual(1);
		});
	}

	it("h4 learns the provider's real output ceiling and tells the model to split the call", async () => {
		const stats = newStats();
		const writes: Array<{ path: string; chars: number }> = [];
		const harness = await createHarness({
			models: [MODELS["GLM-5.3-Flash fallback (262,144 / 262,144)"]],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				writeFileExtension(writes),
				createContextEngine({ stats, log: logger(`h4.${ENGINE_LABEL}.log`) }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness, { honorMaxTokens: true, outputCeiling: 8_192 });
		const model = scriptedModel(harness);
		// The model retries the 60k-char write until told to split, then writes two halves.
		const big = syntheticText(60_000, 7);
		let split = false;
		const step = (context: TranscriptContext) => {
			if (!split && context.messages.some((m) => JSON.stringify(m).includes("smaller"))) split = true;
			const written = new Set(writes.map((w) => w.path));
			if (!split)
				return fauxAssistantMessage([fauxToolCall("write_file", { path: "a.ts", content: big })], {
					stopReason: "toolUse",
				});
			if (!written.has("a.part1"))
				return fauxAssistantMessage(
					[fauxToolCall("write_file", { path: "a.part1", content: big.slice(0, 30_000) })],
					{ stopReason: "toolUse" },
				);
			if (!written.has("a.part2"))
				return fauxAssistantMessage([fauxToolCall("write_file", { path: "a.part2", content: big.slice(30_000) })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage("done");
		};
		model.push(step, step, step, step, step, step);
		model.push(finalTurn("done"));
		await harness.session.prompt("Write a.ts.");
		const hinted = model.requests.some((r) => r.some((m) => m.includes("output limit") && m.includes("smaller")));
		report("h4", ENGINE_LABEL, "real-ceiling", {
			writes,
			lengthStops: sim.calls.filter((c) => c.lengthStop).length,
			maxTokensSent: sim.calls.map((c) => c.maxTokens),
			outputTokens: sim.calls.map((c) => c.outputTokens),
			hinted,
		});
		expect(hinted).toBe(true);
		expect(writes.map((w) => w.path)).toEqual(["a.part1", "a.part2"]);
	});

	it("h4 does not squeeze an Anthropic thinking budget for a 200k / 100k model", async () => {
		const harness = await createHarness({
			models: [MODELS["o3-like (200k / 100k)"]],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({})],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness, { thinkingBudget: 16_000 });
		const model = scriptedModel(harness);
		model.push(finalTurn("ok"));
		await harness.session.prompt("Think hard.");
		const payload = sim.calls[0]?.payload as { max_tokens: number; thinking: { budget_tokens: number } };
		report("h4", ENGINE_LABEL, "thinking", {
			max_tokens: payload.max_tokens,
			budget_tokens: payload.thinking.budget_tokens,
		});
		expect(payload.thinking.budget_tokens).toBe(16_000);
		expect(payload.max_tokens).toBeGreaterThan(16_000);
	});

	it("h4 does not chop a 10k-token answer into continuations for a 200k / 100k model", async () => {
		const harness = await createHarness({
			models: [MODELS["o3-like (200k / 100k)"]],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({})],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const sim = installProviderSim(harness, { honorMaxTokens: true });
		const model = scriptedModel(harness);
		const answer = syntheticText(40_000, 3);
		for (let i = 0; i < 4; i++) model.push(finalTurn(answer));
		await harness.session.prompt("Write the long report.");
		report("h4", ENGINE_LABEL, "long-answer", {
			requests: sim.calls.length,
			lengthStops: sim.calls.filter((c) => c.lengthStop).length,
		});
		expect(sim.calls).toHaveLength(1);
	});
});
