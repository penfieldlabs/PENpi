/**
 * E8: model-written pinned notes and pinned task survive every cut (carried in the window header).
 */
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, NOTES_TOOL, newStats } from "./engine.ts";
import { finalTurn, LOG_DIR, logger, rng, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const results: Record<string, unknown> = {};

describe("context engine: pinned notes", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/notes.json`, JSON.stringify(results, null, 2));
	});

	for (const mode of ["a"] as const) {
		it(`mode ${mode}: notes and task stay in context after older messages leave`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, notesMaxChars: 200, log: logger(`notes.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const model = scriptedModel(harness);
			model.push(
				() =>
					fauxAssistantMessage([fauxToolCall(NOTES_TOOL, { notes: "x".repeat(500) })], { stopReason: "toolUse" }),
				() =>
					fauxAssistantMessage(
						[
							fauxToolCall(NOTES_TOOL, {
								notes: "GOAL: migrate the parser. NEXT: fix tokenizer tests.",
								task: "Migrate the parser to v2.",
							}),
						],
						{ stopReason: "toolUse" },
					),
			);
			const next = rng(2);
			for (let t = 0; t < 60; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), t));
			model.push(finalTurn("done"));
			await harness.session.prompt("Please migrate the parser (original wording of the task).");

			const last = model.requests.at(-1) ?? [];
			const firstNotesRejected = harness.sessionManager
				.getEntries()
				.some(
					(e) =>
						e.type === "message" &&
						e.message.role === "toolResult" &&
						e.message.toolName === NOTES_TOOL &&
						e.message.isError,
				);
			results[mode] = {
				cuts: stats.cuts.length,
				lastRequestHasNotes: last.some((m) => m.includes("GOAL: migrate the parser")),
				lastRequestHasTask: last.some((m) => m.includes("<pinned-task>\\nMigrate the parser to v2.")),
				originalPromptStillInWindow: last.some((m) => m.includes("original wording of the task")),
				firstNotesRejected,
				head: last.slice(1, 2).map((m) => m.slice(0, 400)),
			};
			expect(stats.cuts.length).toBeGreaterThan(0);
			expect(firstNotesRejected).toBe(true);
			expect(last.some((m) => m.includes("GOAL: migrate the parser"))).toBe(true);
			expect(last.some((m) => m.includes("Migrate the parser to v2."))).toBe(true);
		});
	}
});
