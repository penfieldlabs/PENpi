/**
 * E4: no unit too large. A 400k-character tool result and a 200k-character user message enter a
 * 32k-token window. The model sees head/tail plus a pointer; the session keeps the full text; the
 * model pages it back with context_recall.
 */
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, NOTICE_MARKER, newStats } from "./engine.ts";
import {
	analyzePrefixes,
	finalTurn,
	LOG_DIR,
	logger,
	rng,
	scriptedModel,
	syntheticText,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const results: Record<string, unknown> = {};
const WINDOW = 32_000;

describe("context engine: oversized units", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/oversized.json`, JSON.stringify(results, null, 2));
	});

	for (const mode of ["a"] as const) {
		it(`mode ${mode}: caps an oversized tool result and user message, keeps them recoverable`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: WINDOW, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, log: logger(`oversized.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const model = scriptedModel(harness);
			let recall: { entry: string; offset: number } | undefined;
			model.push(
				() => fauxAssistantMessage([fauxToolCall("work", { size: 400_000, seed: 77 })], { stopReason: "toolUse" }),
				(context) => {
					const last = context.messages.at(-1);
					const text = last && last.role === "toolResult" ? (last.content[0] as { text: string }).text : "";
					const match = text.match(/"entry": "([^"]+)", "offset": (\d+)/);
					recall = match ? { entry: match[1], offset: Number(match[2]) } : undefined;
					return fauxAssistantMessage([fauxToolCall("context_recall", { ...recall, limit: 3_000 })], {
						stopReason: "toolUse",
					});
				},
				finalTurn("read it"),
			);
			await harness.session.prompt("Run the big job.");

			const bigUser = syntheticText(200_000, 99);
			model.push(finalTurn("got the paste"));
			await harness.session.prompt(bigUser);

			// Keep working afterwards: the capped forms must stay byte-stable.
			const next = rng(1);
			for (let t = 0; t < 30; t++) model.push(toolTurn(1_000 + Math.floor(next() * 3_000), 1000 + t));
			model.push(finalTurn("more done"));
			await harness.session.prompt("Continue.");

			const toolEntry = harness.sessionManager
				.getEntries()
				.find((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "work");
			const storedText =
				toolEntry?.type === "message"
					? ((toolEntry.message as unknown as { content: Array<{ text: string }> }).content[0].text ?? "")
					: "";
			const recallEntry = harness.sessionManager
				.getEntries()
				.find(
					(e) =>
						e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "context_recall",
				);
			const recallText =
				recallEntry?.type === "message"
					? ((recallEntry.message as unknown as { content: Array<{ text: string }> }).content[0].text ?? "")
					: "";
			const userEntry = harness.sessionManager
				.getEntries()
				.find(
					(e) =>
						e.type === "message" &&
						e.message.role === "user" &&
						JSON.stringify(e.message.content).length > 100_000,
				);
			const prefixAfterUser = analyzePrefixes(
				model.requests.slice(3),
				(m) => NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER),
			);
			results[mode] = {
				maxPromptTokens: Math.max(...model.promptTokens),
				promptTokens: model.promptTokens.slice(0, 6),
				storedToolChars: storedText.length,
				recall,
				recallMatchesOriginal: recallText.includes(
					storedText.slice(recall?.offset ?? 0, (recall?.offset ?? 0) + 200),
				),
				userStoredChars: userEntry ? JSON.stringify(userEntry).length : 0,
				capped: stats.capped,
				cuts: stats.cuts.length,
				guardTrims: stats.guardTrims,
				prefixAfterUser,
				contextEdits: harness.sessionManager.getEntries().filter((e) => e.type === "context_edit").length,
			};
			expect(Math.max(...model.promptTokens)).toBeLessThanOrEqual(WINDOW);
			expect(storedText.length).toBe(400_000);
			expect(recall).toBeDefined();
			expect(recallText).toContain(storedText.slice(recall!.offset, recall!.offset + 200));
			expect(userEntry).toBeDefined();
			expect(prefixAfterUser.breaks).toBeLessThanOrEqual(stats.cuts.length + stats.guardTrims);
		});
	}
});
