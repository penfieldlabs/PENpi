/**
 * 0.6.0 (Pi 1.4): `before_agent_start` also fires for a run started by an extension's custom message
 * (`sendMessage(..., { triggerTurn: true })` while idle). Such a run has no user prompt: the engine records no run
 * prompt for it and the header does not pin it, while the user's prompts before and after it are recorded as before.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, workExtension } from "./helpers.ts";

describe("0.6.0: a run started by a custom message", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("v060 a custom-triggered run records no run prompt; the user's prompts around it are recorded", async () => {
		resetEntryIds();
		const stats = newStats();
		const lines: string[] = [];
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				(pi: ExtensionAPI) => {
					api = pi;
				},
				createContextEngine({ stats, log: (l) => lines.push(l) }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness);

		model.push(finalTurn("First done."));
		await harness.session.prompt("Fix the parser.");
		model.push(finalTurn("Reminder handled."));
		api!.sendMessage(
			{ customType: "reminder", content: "A scheduled reminder fired.", display: true },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();
		model.push(finalTurn("Second done."));
		await harness.session.prompt("And the lexer.");

		expect(model.requests).toHaveLength(3);
		expect(lines.filter((l) => l.includes("context_with_system error"))).toEqual([]);
		const runs = lines.filter((l) => l.includes("run prompt ("));
		expect(runs).toEqual(["[a] run prompt (run, 15 chars)", "[a] run prompt (run, 14 chars)"]);
		const recorded = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && (e as { data?: { kind?: string } }).data?.kind === "run")
			.map((e) => (e as { data: { prompt?: string } }).data.prompt);
		expect(recorded).toEqual(["Fix the parser.", "And the lexer."]);
	});
});
