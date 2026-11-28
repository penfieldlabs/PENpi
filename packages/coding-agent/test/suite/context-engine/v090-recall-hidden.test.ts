/**
 * 0.9.0: context_recall refuses what context_search hides. Search skips a message the host never sends
 * (hiddenCustomTypes: PENpi 0.4's briefing, Penfield memory) and a system message; recall by id read both. It now
 * refuses them with the error of a missing entry, so the answer doesn't show the entry exists, and an ordinary call
 * still reads with its paired result.
 */

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { scriptedModel } from "./helpers.ts";

const HIDDEN = "penpi.briefing";
const PATH = "ops/freeze-window.yaml";
const FILE = "cutover_ticket: FW-60237-NQ";

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	return last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

describe("0.9.0: context_recall refuses the entries context_search hides", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("a hidden briefing and a system message: recall fails as for a missing entry; an ordinary call reads", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({ stats: newStats(), hiddenCustomTypes: [HIDDEN] })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const briefing = harness.sessionManager.appendCustomMessageEntry(HIDDEN, "BRIEFMARK-41 the owner's notes", false);
		// A later system message: instructions from this point on.
		const system = harness.sessionManager.appendMessage({
			role: "system",
			content: "SYSMARK-7 answer in French",
			timestamp: Date.now(),
		});
		const callId = harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: PATH }, { id: "call-read" })], { stopReason: "toolUse" }),
		);
		const resultId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text: FILE }],
			isError: false,
			timestamp: Date.now(),
		});
		const model = scriptedModel(harness);
		const replies: string[] = [];
		const step =
			(name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => (context: TranscriptContext) => {
				replies.push(lastToolText(context));
				return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
			};
		model.push(
			() =>
				fauxAssistantMessage(
					[fauxToolCall("context_search", { query: "BRIEFMARK-41", scope: "all" }, { id: "s1" })],
					{
						stopReason: "toolUse",
					},
				),
			step("context_search", { query: "SYSMARK-7", scope: "all" }, "s2"),
			step("context_recall", { entry: briefing }, "r1"),
			step("context_recall", { entry: system }, "r2"),
			step("context_recall", { entry: "no-such-entry" }, "r3"),
			step("context_recall", { entry: callId }, "r4"),
			(context) => {
				replies.push(lastToolText(context));
				return fauxAssistantMessage([fauxText("done")]);
			},
		);
		await harness.session.prompt("Look it up.");
		const [searchHidden, searchSystem, recallHidden, recallSystem, recallMissing, recallCall] = replies;

		// Search hides both, as before.
		expect(searchHidden).toBe('[context_search "BRIEFMARK-41" (all): 0 entries match.]');
		expect(searchSystem).toBe('[context_search "SYSMARK-7" (all): 0 entries match.]');
		// Recall refuses both, word for word as for an entry that doesn't exist.
		expect(recallMissing).toBe("No readable entry no-such-entry");
		expect(recallHidden).toBe(`No readable entry ${briefing}`);
		expect(recallSystem).toBe(`No readable entry ${system}`);
		// An ordinary call still reads, with its paired result on the last page.
		expect(recallCall).toContain(`read({"path":"${PATH}"})`);
		expect(recallCall).toContain(`[result of read: entry ${resultId}, ${FILE.length} characters]`);
		expect(recallCall).toContain(FILE);
	});
});
