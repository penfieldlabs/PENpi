/**
 * Behaviours without a test, item 4: learned output state survives reload. A provider output ceiling
 * learned from length stops (8,192 on a model declaring 32,768) bounds max_tokens; the first request
 * after a /reload and after a resume asks for the same max_tokens.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, reloadKeepingFaux, scriptedModel } from "./helpers.ts";

const MODEL = { id: "glm-200k", contextWindow: 200_000, maxTokens: 32_768 };

async function open(sessionManager: SessionManager) {
	const stats = newStats();
	const factories: ExtensionFactory[] = [createContextEngine({ stats })];
	let current = await createTestExtensionsResult(factories, sessionManager.getCwd());
	const harness = await createHarness({
		models: [MODEL],
		settings: { compaction: { enabled: false } },
		sessionManager,
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult: current }),
			getExtensions: () => current,
			reload: async () => {
				current = await createTestExtensionsResult(factories, sessionManager.getCwd());
			},
		},
	});
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	const sim = installProviderSim(harness, { honorMaxTokens: true, outputCeiling: 8_192 });
	return { harness, stats, sim, model: scriptedModel(harness) };
}

describe("learned output state", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("b04 learned output state survives reload: the same max_tokens on the first request after reload and resume", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ce-b04-"));
		const first = await open(SessionManager.create(dir, dir));
		harnesses.push(first.harness);
		// Long answers stop at the provider's 8,192-token ceiling, below the max_tokens asked: learned at the second.
		const long = () => finalTurn("y".repeat(60_000 * 4));
		first.model.push(long(), long(), finalTurn("done"));
		await first.harness.session.prompt("Write the full report.");
		expect(first.stats.outputCeilings.at(-1)?.ceiling).toBe(8_192);
		first.model.push(finalTurn("ok"));
		await first.harness.session.prompt("Thanks.");
		const learned = first.sim.calls.at(-1)?.maxTokens;
		expect(learned).toBeLessThanOrEqual(8_192);

		await reloadKeepingFaux(first.harness);
		const before = first.sim.calls.length;
		first.model.push(finalTurn("after reload"));
		await first.harness.session.prompt("After reload.");
		expect(first.sim.calls.length).toBe(before + 1);
		expect(first.sim.calls.at(-1)?.maxTokens).toBe(learned);

		const resumed = await open(SessionManager.open(first.harness.sessionManager.getSessionFile()!));
		harnesses.push(resumed.harness);
		resumed.model.push(finalTurn("after resume"));
		await resumed.harness.session.prompt("After resume.");
		expect(resumed.sim.calls[0]?.maxTokens).toBe(learned);
	});
});
