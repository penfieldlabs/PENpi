/**
 * Behaviours without a test, item 13 (E3.9): quarantined samples never move the calibration ratio. After
 * a detection the engine plans with the ratio from before the first answer it named as truncated (the
 * quarantined samples, and samples that reported exactly what a quarantined one did), with one strong
 * sample and with two weak ones.
 */

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

/** Outermost wrapper: `usage(call, honest, previous)` replaces the reported input (undefined: honest). */
function scriptUsage(harness: Harness, usage: (call: number, honest: number, previous: number) => number | undefined) {
	const reported: number[] = [];
	const agent = harness.session.agent;
	const inner = agent.streamFunction;
	agent.streamFunction = async (model, context, options) => {
		const call = reported.length;
		reported.push(0);
		const source = await inner(model, context, options);
		const stream = createAssistantMessageEventStream();
		(async () => {
			for await (const event of source) {
				if (event.type === "done") {
					const honest = event.message.usage.input;
					const value = usage(call, honest, call > 0 ? reported[call - 1] : 0) ?? honest;
					reported[call] = value;
					const message: AssistantMessage = {
						...event.message,
						usage: { ...event.message.usage, input: value, totalTokens: value + event.message.usage.output },
					};
					stream.push({ ...event, message });
					stream.end(message);
					return;
				}
				if (event.type === "error") {
					stream.push(event);
					stream.end(event.error);
					return;
				}
				stream.push(event);
			}
		})();
		return stream;
	};
}

describe("E3.9: quarantined samples and the ratio", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(usage: (call: number, honest: number, previous: number) => number | undefined) {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "glm-200k", contextWindow: 200_000, maxTokens: 16_384 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// A provider that counts 1.3x the estimate: the ratio is still moving when the anomaly comes.
		installProviderSim(harness, { scale: 1.3 });
		scriptUsage(harness, usage);
		const model = scriptedModel(harness, 400);
		for (let i = 0; i < 22; i++) model.push(toolTurn(8_000, 100 + i));
		model.push(finalTurn("done"));
		await harness.session.prompt("Process the batch.");
		return stats;
	}

	/** The ratio the request of the first answer the engine named was planned with (turn n answered call n - 1). */
	const firstNamed = (stats: Awaited<ReturnType<typeof run>>) => {
		const turn = Math.min(
			...stats.plateauReports.flatMap((r) => r.turns.map((t) => t.turn ?? Number.POSITIVE_INFINITY)),
		);
		return { call: turn - 1, ratio: stats.sent[turn - 1].ratio };
	};

	it("b13 one strong sample: the ratio after detection is the ratio before the first named answer", async () => {
		// Call 8 reports exactly call 7's usage after a full tool result: strong evidence, acted on at once. Call 7
		// reported the same count, so it is named too (a server that fills its context reports its limit).
		const stats = await run((call, _honest, previous) => (call === 8 ? previous : undefined));
		expect(stats.plateaus).toHaveLength(1);
		const first = firstNamed(stats);
		expect(first.call).toBe(7);
		expect(stats.sent[9].ratio).toBe(first.ratio);
		// Not the ratio the quarantined call was planned with (that one had moved with call 7's sample).
		expect(stats.sent[9].ratio).not.toBe(stats.sent[8].ratio);
	});

	it("b13 two weak samples: neither moves the ratio, and after detection it is the ratio before the first", async () => {
		// Calls 16 and 17 each report a fifth of their honest growth: weak evidence, and the second stays below
		// 2% above the maximum, so it confirms the first instead of clearing it.
		const honestAt: number[] = [];
		const reportedAt: number[] = [];
		const stats = await run((call, honest) => {
			honestAt[call] = honest;
			let value: number | undefined;
			if (call === 16 || call === 17) value = reportedAt[call - 1] + Math.round(0.2 * (honest - honestAt[call - 1]));
			reportedAt[call] = value ?? honest;
			return value;
		});
		expect(stats.plateaus).toHaveLength(1);
		const before = stats.sent[16].ratio;
		// The ratio was still moving: the clean sample of call 15 changed it, so "unchanged" below is the quarantine.
		expect(before).not.toBe(stats.sent[15].ratio);
		// Call 17 was planned with the ratio the quarantined call 16 left unchanged; after detection, the same.
		expect(stats.sent[17].ratio).toBe(before);
		expect(firstNamed(stats).ratio).toBe(before);
		expect(stats.sent[18].ratio).toBe(before);
	});
});
