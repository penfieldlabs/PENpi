/**
 * Behaviours without a test, item 3 (E4.3): frozen cap decisions survive reload, resume and fork. An
 * oversized tool result is capped once; the same capped text and placeholder are sent after a /reload (a
 * fresh extension instance), a resume (the session file reopened) and a fork (a copied session file),
 * although the calibration ratio moved after the cap (a fresh decision would keep less).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, reloadKeepingFaux, scriptedModel, workExtension } from "./helpers.ts";

/** Provider tokens per estimated token; raised after the cap so the ratio moves. */
const provider = { scale: 1 };

async function open(sessionManager: SessionManager) {
	const stats = newStats();
	const factories: ExtensionFactory[] = [workExtension, createContextEngine({ stats })];
	let current = await createTestExtensionsResult(factories, sessionManager.getCwd());
	const loader = {
		...createTestResourceLoader({ extensionsResult: current }),
		getExtensions: () => current,
		reload: async () => {
			current = await createTestExtensionsResult(factories, sessionManager.getCwd());
		},
	};
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		sessionManager,
		resourceLoader: loader,
	});
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	installProviderSim(harness, { scale: () => provider.scale });
	return { harness, stats, model: scriptedModel(harness) };
}

/** The serialized oversized tool result as the last request carried it. */
function capped(requests: string[][]): string {
	const message = requests.at(-1)?.find((m) => m.includes('"toolCallId":"big-1"'));
	if (!message) throw new Error("the capped tool result is not in the request");
	return message;
}

describe("E4.3: frozen cap decisions", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("b03 the same capped text and placeholder after reload, resume and fork", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ce-b03-"));
		const first = await open(SessionManager.create(dir, dir));
		harnesses.push(first.harness);
		first.model.push(
			() =>
				fauxAssistantMessage([fauxToolCall("work", { size: 400_000, seed: 77 }, { id: "big-1" })], {
					stopReason: "toolUse",
				}),
			finalTurn("read it"),
		);
		await first.harness.session.prompt("Run the export.");
		first.model.push(finalTurn("ok"));
		await first.harness.session.prompt("Next.");
		const original = capped(first.model.requests);
		expect(original).toContain("are not shown here");
		expect(original.length).toBeLessThan(200_000);
		expect(first.stats.capped).toBeGreaterThan(0);
		// The provider now counts 1.6x: the ratio rises (and is persisted), so a fresh cap would be smaller.
		provider.scale = 1.6;
		for (let i = 0; i < 6; i++) {
			first.model.push(finalTurn(`ok ${i}`));
			await first.harness.session.prompt(`Step ${i}.`);
		}
		expect(first.stats.sent.at(-1)?.ratio).toBeGreaterThan(1.3);
		expect(capped(first.model.requests)).toBe(original);

		await reloadKeepingFaux(first.harness);
		const before = first.model.requests.length;
		first.model.push(finalTurn("after reload"));
		await first.harness.session.prompt("After reload.");
		// A new request reached the model after the reload, from an engine that reloaded the persisted ratio.
		expect(first.model.requests.length).toBe(before + 1);
		expect(first.stats.sent.at(-1)?.ratio).toBeGreaterThan(1.3);
		expect(capped(first.model.requests)).toBe(original);

		const file = first.harness.sessionManager.getSessionFile()!;
		const resumed = await open(SessionManager.open(file));
		harnesses.push(resumed.harness);
		resumed.model.push(finalTurn("after resume"));
		await resumed.harness.session.prompt("After resume.");
		expect(resumed.stats.sent[0]?.ratio).toBeGreaterThan(1.3);
		expect(capped(resumed.model.requests)).toBe(original);

		const forked = await open(SessionManager.forkFrom(file, dir, dir));
		harnesses.push(forked.harness);
		forked.model.push(finalTurn("after fork"));
		await forked.harness.session.prompt("After fork.");
		expect(capped(forked.model.requests)).toBe(original);
	});
});
