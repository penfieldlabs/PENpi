/**
 * Behaviours without a test, item 14: truncation by a server that reports no usage cannot be detected
 * (the detector judges reported usage). Doctor says so instead of implying detection is on.
 */

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { installProviderSim, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

/** Outermost wrapper: the provider reports no input usage at all. */
function dropUsage(harness: Harness): void {
	const agent = harness.session.agent;
	const inner = agent.streamFunction;
	agent.streamFunction = async (model, context, options) => {
		const source = await inner(model, context, options);
		const stream = createAssistantMessageEventStream();
		(async () => {
			for await (const event of source) {
				if (event.type === "done") {
					const message: AssistantMessage = {
						...event.message,
						usage: {
							...event.message.usage,
							input: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: event.message.usage.output,
						},
					};
					stream.push({ ...event, message });
					stream.end(message);
					return;
				}
				stream.push(event);
				if (event.type === "error") {
					stream.end(event.error);
					return;
				}
			}
		})();
		return stream;
	};
}

describe("detection without usage", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function doctorAfter(reportsUsage: boolean) {
		const stats = newStats();
		const notices: string[] = [];
		const harness = await createHarness({
			models: [{ id: "glm-200k", contextWindow: 200_000, maxTokens: 16_384 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
		const sim = installProviderSim(harness, { silentLimit: 40_000, silentReport: "remainder" });
		if (!reportsUsage) dropUsage(harness);
		await runPrompts(harness, scriptedModel(harness, 4_000), { prompts: 3, turns: 10, min: 7_000, spread: 2_000 });
		const before = notices.length;
		await harness.session.prompt("/penpi doctor");
		return { stats, sim, doctor: notices.slice(before).join("\n") };
	}

	it('b14 a server that reports no usage truncates undetected; doctor shows "silent-truncation detection unavailable: no usage reported"', async () => {
		const silent = await doctorAfter(false);
		expect(silent.sim.calls.some((c) => c.truncatedInput)).toBe(true);
		expect(silent.stats.plateaus).toHaveLength(0);
		expect(silent.doctor).toContain("silent-truncation detection unavailable: no usage reported");
		// With usage, the same server is detected and doctor reports detection as on.
		const honest = await doctorAfter(true);
		expect(honest.stats.plateaus.length).toBeGreaterThan(0);
		expect(honest.doctor).toContain("silent-truncation detection: on");
	});
});
