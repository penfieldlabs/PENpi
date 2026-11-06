/**
 * 0.6.1 (the second reviewer's finding on 0.6.0): when Pi's messages for a request do not line up with the engine's
 * record of the session, the engine sends them uncut (planner.ts, the mismatch branch). Another extension that appends
 * a message in Pi's `context` event causes that on every request, and nothing told the user: the reviewer saw 0 cuts,
 * 120 of 120 mismatches and requests growing past the window. The engine now warns once per session, and
 * `/penpi doctor` shows the count.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, workExtension } from "./helpers.ts";

/** A second extension that appends one message to every request in `context`. */
function appender(pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: [
			...event.messages,
			{
				role: "user",
				content: [{ type: "text", text: "(a note another extension adds)" }],
				timestamp: Date.now(),
			} as AgentMessage,
		],
	}));
}

describe("0.6.1: the engine says when it steps aside", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function session(extra: boolean) {
		const stats = newStats();
		const notices: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, ...(extra ? [appender] : []), createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
		const model = scriptedModel(harness);
		for (let p = 0; p < 3; p++) {
			model.push(finalTurn(`done ${p}`));
			await harness.session.prompt(`task ${p}`);
		}
		const before = notices.length;
		await harness.session.prompt("/penpi doctor");
		return {
			stats,
			warnings: notices.slice(0, before).filter((n) => n.includes("do not match the engine's record")),
			doctor: notices.slice(before).join("\n"),
		};
	}

	it("a context-hook extension that appends a message: one warning per session, and doctor counts the requests", async () => {
		const { stats, warnings, doctor } = await session(true);
		expect(stats.alignMismatches).toBe(3);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("the engine is not managing the window");
		expect(warnings[0]).toContain(`another extension adding or removing messages in Pi's "context" event`);
		expect(doctor).toContain("requests not matching the engine's record: 3 this session, sent uncut");
	});

	it("without a UI (print and json mode): the warning goes to stderr, once (0.6.1 review, N1)", async () => {
		const written: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		try {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [workExtension, appender, createContextEngine({ stats })],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({}); // no UI context: hasUI is false, notify does nothing
			const model = scriptedModel(harness);
			for (let p = 0; p < 3; p++) {
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`task ${p}`);
			}
			expect(stats.alignMismatches).toBe(3);
		} finally {
			spy.mockRestore();
		}
		const lines = written.filter((w) => w.includes("do not match the engine's record"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^context-engine: .*the engine is not managing the window.*\n$/);
	});

	it("without one: no warning, and doctor says none", async () => {
		const { stats, warnings, doctor } = await session(false);
		expect(stats.alignMismatches).toBe(0);
		expect(warnings).toHaveLength(0);
		expect(doctor).toContain("requests not matching the engine's record: none");
	});
});
