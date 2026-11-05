/**
 * 0.6.1 (the external reviewer's note on the 0.6.0 gate, candidate s10): context_search on a file name listed the
 * read's call ("31b12f53 ... result: bc1137a0"), the model recalled the call's id, got back only
 * `read({"path":"ops/freeze-window.yaml"})` (39 characters) and answered that the output was no longer retrievable.
 * Recalling a tool call's entry now returns each call's result after it on the entry's last page: in full when it fits
 * the page, else a line naming the result's entry to recall.
 */

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { scriptedModel } from "./helpers.ts";

const PATH = "ops/freeze-window.yaml";
const FILE = [
	"# Cutover plan.",
	"name: winter-freeze",
	"cutover_ticket: FW-60237-NQ",
	"services:",
	"  - name: payments",
].join("\n");

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	return last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

describe("0.6.1: context_recall on a tool call's entry", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function recallCall(
		resultText: string,
	): Promise<{ search: string; recalled: string; callId: string; resultId: string }> {
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({ stats: newStats() })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const callId = harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: PATH }, { id: "call-read" })], { stopReason: "toolUse" }),
		);
		const resultId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text: resultText }],
			isError: false,
			timestamp: Date.now(),
		});
		const model = scriptedModel(harness);
		const replies: string[] = [];
		model.push(
			() =>
				fauxAssistantMessage([fauxToolCall("context_search", { query: PATH, scope: "all" }, { id: "s1" })], {
					stopReason: "toolUse",
				}),
			(context) => {
				replies.push(lastToolText(context));
				// s10: the model recalls the call's id, not the result's.
				return fauxAssistantMessage([fauxToolCall("context_recall", { entry: callId }, { id: "r1" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				replies.push(lastToolText(context));
				return fauxAssistantMessage([fauxText("ANSWER: FW-60237-NQ")]);
			},
		);
		await harness.session.prompt(`Earlier you read \`${PATH}\`. What was "cutover_ticket" in it?`);
		return { search: replies[0], recalled: replies[1], callId, resultId };
	}

	it("s10: search names the call and its result; recalling the call's id returns the result's content", async () => {
		const { search, recalled, callId, resultId } = await recallCall(FILE);
		expect(search).toContain(`- ${callId} · `);
		expect(search).toContain(`result: ${resultId}`);
		expect(recalled).toContain(`read({"path":"${PATH}"})`);
		expect(recalled).toContain(`[result of read: entry ${resultId}, ${FILE.length} characters]`);
		expect(recalled).toContain("cutover_ticket: FW-60237-NQ");
	});

	it("a result too long for the page: the reply ends with a line naming the result's entry to recall", async () => {
		const big = `${"filler line of a long file\n".repeat(20_000)}cutover_ticket: FW-60237-NQ\n`;
		const { recalled, resultId } = await recallCall(big);
		expect(recalled).not.toContain("cutover_ticket");
		expect(recalled.trimEnd().split("\n").at(-1)).toBe(
			`[result of read: entry ${resultId}, ${big.length} characters; read it with context_recall({"entry":"${resultId}"})]`,
		);
	});
});
