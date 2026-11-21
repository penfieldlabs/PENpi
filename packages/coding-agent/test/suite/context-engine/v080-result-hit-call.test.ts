/**
 * 0.8.0: a tool result's hit names its call. A result hit read `tool result bash` and a snippet of the output; the
 * command or path was searched (D16) but not shown. Two sibling scripts that print alike gave two hits the model could
 * not tell apart (a PENpi-bench check: `row-audit` and `row-audit-legacy`). A result hit now shows its
 * call's argument values after `from: `, whitespace folded and clipped at 100 characters. A hit matched only through
 * its call already shows the call in its snippet (`call: `), and an assistant message names its results instead.
 */

import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { scriptedModel } from "./helpers.ts";

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	return last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

const hitLine = (reply: string, id: string) => reply.split("\n").find((l) => l.startsWith(`- ${id} ·`));

describe("0.8.0: a result hit names its call", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A branch of tool calls and their results written directly, then the queries, each with scope "all". */
	async function searchBranch(
		calls: Array<{ id: string; args: ToolCall["arguments"]; result: string }>,
		queries: string[],
	) {
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({ stats: newStats() })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ids: Array<{ call: string; result: string }> = [];
		for (const c of calls) {
			const call = harness.sessionManager.appendMessage(
				fauxAssistantMessage([fauxToolCall("bash", c.args, { id: c.id })], { stopReason: "toolUse" }),
			);
			const result = harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: c.id,
				toolName: "bash",
				content: [{ type: "text", text: c.result }],
				isError: false,
				timestamp: Date.now(),
			});
			ids.push({ call, result });
		}
		const model = scriptedModel(harness);
		const replies: string[] = [];
		for (const [k, query] of queries.entries())
			model.push((context) => {
				if (k > 0) replies.push(lastToolText(context));
				return fauxAssistantMessage([fauxToolCall("context_search", { query, scope: "all" }, { id: `q${k}` })], {
					stopReason: "toolUse",
				});
			});
		model.push((context) => {
			replies.push(lastToolText(context));
			return fauxAssistantMessage([fauxText("done")]);
		});
		await harness.session.prompt("Search.");
		return { replies, ids };
	}

	it("two sibling scripts that print alike: each result hit names its own command", async () => {
		const { replies, ids } = await searchBranch(
			[
				{ id: "c1", args: { command: "node scripts/row-audit.mjs" }, result: "orphaned record total: 41\nok" },
				{
					id: "c2",
					args: { command: "node scripts/row-audit-legacy.mjs" },
					result: "orphaned record total: 7\nok",
				},
			],
			["orphaned record total"],
		);
		const [reply] = replies;
		expect(reply).toMatch(/2 entries match; 2 shown, newest first/);
		expect(hitLine(reply, ids[0].result)).toContain(
			"· tool result bash · in view · from: node scripts/row-audit.mjs · orphaned record total: 41",
		);
		expect(hitLine(reply, ids[1].result)).toContain(
			"· tool result bash · in view · from: node scripts/row-audit-legacy.mjs · orphaned record total: 7",
		);
	});

	it("a long command is folded to one line and clipped at 100 characters", async () => {
		const command = `cd repo &&\n\tnode scripts/export.mjs --format csv ${"--column field ".repeat(10)}--out report.csv`;
		const { replies, ids } = await searchBranch(
			[{ id: "c1", args: { command }, result: "exported rows: 1200" }],
			["exported rows"],
		);
		const line = hitLine(replies[0], ids[0].result) ?? "";
		const from = /· from: (.*?) · exported rows/.exec(line)?.[1] ?? "";
		expect(from).toHaveLength(100);
		expect(from.endsWith("…")).toBe(true);
		expect(from.startsWith("cd repo && node scripts/export.mjs --format csv --column field")).toBe(true);
	});

	it("a hit matched only through its call, and a call hit, show no from:", async () => {
		const { replies, ids } = await searchBranch(
			[
				{ id: "c1", args: { command: "node scripts/shard-map.mjs" }, result: "42" },
				{ id: "c2", args: { command: "ls" }, result: "shard-map.mjs" },
			],
			["shard-map.mjs"],
		);
		const [reply] = replies;
		// The call of c1 is a hit and names its result; the c2 result matches on its own text and names `ls`.
		expect(hitLine(reply, ids[0].call)).toContain(`· result: ${ids[0].result} ·`);
		expect(hitLine(reply, ids[0].call)).not.toContain("from: ");
		expect(hitLine(reply, ids[1].result)).toContain("· from: ls · shard-map.mjs");
		expect(hitLine(reply, ids[0].result)).toBeUndefined();
	});
});
