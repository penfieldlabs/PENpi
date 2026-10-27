/**
 * D16: context_search missed a tool result when the query named the file it came from: a read result does not
 * contain its own path, which is in the assistant's tool call. A result is now searched together with its call,
 * and a hit on a call names its result entry (`result: <id>`). When no entry has every word, the entries with
 * some of them are listed, most words first, and the reply says so.
 *
 * Fixture: E4 arm S, session s14, trimmed. The model read `ops/freeze-window.yaml`, the read left the window, and
 * asked later for its approval_code. Its queries were `freeze-window approval_code` (no entry had both words)
 * and `freeze-window.yaml` (the call and its own summary, not the result); it answered "unknown".
 */

import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const PATH = "ops/freeze-window.yaml";
/** The file as s14 read it, cut to its first lines (the fact is the approval code). */
const FILE = [
	"# Cutover plan. Owned by the release team.",
	"name: winter-freeze",
	"approval_code: CHG-15445-LG",
	"window_start: 2026-10-16T02:00:00Z",
	"services:",
	"  - name: payments",
	"    order: 16",
	"  - name: catalog",
	"    order: 18",
].join("\n");

function readExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read",
		description: "Read a file.",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (_id, { path }) => ({
			content: [{ type: "text", text: path === PATH ? FILE : `no such file: ${path}` }],
			details: {},
		}),
	});
}

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	return last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

describe("D16: context_search finds a tool result by its call's arguments", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d16 s14: both of the model's queries find the read result, and recall returns the approval code", async () => {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [readExtension, workExtension, createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness);

		// s14 turn 10: the read, and the model's answer about the file.
		model.push(
			() =>
				fauxAssistantMessage([fauxToolCall("read", { path: PATH }, { id: "call-read" })], {
					stopReason: "toolUse",
				}),
			finalTurn(`\`${PATH}\` lists **2 services** (payments, catalog).`),
		);
		await harness.session.prompt(`Read \`${PATH}\` and tell me how many services it lists.`);
		const resultEntry = harness.sessionManager
			.getBranch()
			.find((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "read");
		const callEntry = harness.sessionManager
			.getBranch()
			.find(
				(e) =>
					e.type === "message" &&
					e.message.role === "assistant" &&
					e.message.content.some((b) => b.type === "toolCall" && b.name === "read"),
			);
		expect(resultEntry && callEntry).toBeTruthy();

		// Later work pushes the read out of the window.
		for (let p = 0; p < 2; p++) {
			for (let t = 0; t < 12; t++) model.push(toolTurn(6_000, p * 100 + t));
			model.push(finalTurn(`done ${p}`));
			await harness.session.prompt(`task ${p}: process the next batch.`);
		}
		expect(stats.cuts.length).toBeGreaterThan(0);

		// s14 turn 40: the model's own queries, then a recall of the first result entry the search names.
		const replies: string[] = [];
		const search = (query: string, id: string) => (context: TranscriptContext) => {
			const previous = lastToolText(context);
			if (previous) replies.push(previous);
			return fauxAssistantMessage([fauxToolCall("context_search", { query }, { id })], { stopReason: "toolUse" });
		};
		model.push(
			search("freeze-window approval_code", "s1"),
			search("freeze-window.yaml", "s2"),
			search("approval_code winter-thaw", "s3"),
			(context) => {
				replies.push(lastToolText(context));
				return fauxAssistantMessage([fauxToolCall("context_recall", { entry: resultEntry!.id }, { id: "r1" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				replies.push(lastToolText(context));
				return fauxAssistantMessage([fauxText("ANSWER: CHG-15445-LG")]);
			},
		);
		await harness.session.prompt(
			`Earlier you read \`${PATH}\` (it has since been deleted). What was the exact value of "approval_code" in it?`,
		);
		const [both, byPath, partial, recalled] = replies;

		// `freeze-window approval_code`: the result has approval_code, its call has the path.
		expect(both).toMatch(/1 entry matches/);
		expect(both).toContain(`- ${resultEntry!.id} · turn `);
		expect(both).toContain("tool result read · out of view · ");
		// `freeze-window.yaml`: the call names its result; the result, matched only through that call, is not
		// listed again (F4).
		expect(byPath).toContain(`- ${callEntry!.id} · turn `);
		expect(byPath).toContain(`· result: ${resultEntry!.id} ·`);
		expect(byPath).not.toContain(`- ${resultEntry!.id} · turn `);
		// No entry has both words: the ones with some, most words first, said so.
		expect(partial).toMatch(
			/no entry has every word; \d+ entr(y has|ies have) some of them; \d+ shown, most words first/,
		);
		expect(partial.split("\n")[1]).toContain(`- ${resultEntry!.id} · `);
		expect(partial.split("\n")[1]).toContain("· 1 of 2 words ·");
		// The recall of the named result returns the fact.
		expect(recalled).toContain("approval_code: CHG-15445-LG");
	});
});

/** A session whose branch is written directly: assistant tool calls and their results, then searched. */
async function branchSearch(
	entries: Array<{ calls: Array<{ id: string; name: string; args: ToolCall["arguments"]; result?: string }> }>,
	queries: string[],
) {
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [createContextEngine({ stats: newStats() })],
	});
	await harness.session.bindExtensions({});
	const ids: Array<{ call: string; results: Record<string, string> }> = [];
	for (const { calls } of entries) {
		const call = harness.sessionManager.appendMessage(
			fauxAssistantMessage(
				calls.map((c) => fauxToolCall(c.name, c.args, { id: c.id })),
				{ stopReason: "toolUse" },
			),
		);
		const results: Record<string, string> = {};
		for (const c of calls) {
			if (c.result === undefined) continue;
			results[`${c.name}:${JSON.stringify(c.args)}`] = harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: c.id,
				toolName: c.name,
				content: [{ type: "text", text: c.result }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		ids.push({ call, results });
	}
	const model = scriptedModel(harness);
	const replies: string[] = [];
	for (const [k, query] of queries.entries()) {
		model.push((context) => {
			if (k > 0) replies.push(lastToolText(context));
			return fauxAssistantMessage([fauxToolCall("context_search", { query, scope: "all" }, { id: `q${k}` })], {
				stopReason: "toolUse",
			});
		});
	}
	model.push((context) => {
		replies.push(lastToolText(context));
		return fauxAssistantMessage([fauxText("done")]);
	});
	await harness.session.prompt("Search.");
	harness.cleanup();
	return { replies, ids };
}

const hitLine = (reply: string, id: string) => reply.split("\n").find((l) => l.startsWith(`- ${id} ·`));

describe("D16 follow-ups (review round 2)", () => {
	it("Later 9: a result is searched with its call's argument values, not the tool name or JSON keys", async () => {
		const { replies, ids } = await branchSearch(
			[{ calls: [{ id: "r1", name: "read", args: { path: "src/a.ts", limit: 40 }, result: "alpha body" }] }],
			["alpha path", "alpha read", "alpha a.ts"],
		);
		const result = ids[0].results['read:{"path":"src/a.ts","limit":40}'];
		// "path" is a key and "read" the tool name: neither makes the result hold every word.
		expect(replies[0]).toMatch(/no entry has every word/);
		expect(replies[1]).toMatch(/no entry has every word/);
		// The value does.
		expect(replies[2]).toMatch(/1 entry matches/);
		expect(hitLine(replies[2], result)).toBeDefined();
	});

	it("Later 8: a result pairs with its own call in branch order, even when ids repeat or are empty", async () => {
		const { replies, ids } = await branchSearch(
			[
				{ calls: [{ id: "dup", name: "read", args: { path: "src/a.ts" }, result: "alpha body" }] },
				{ calls: [{ id: "dup", name: "read", args: { path: "src/b.ts" }, result: "beta body" }] },
				{ calls: [{ id: "", name: "read", args: { path: "src/c.ts" }, result: "gamma body" }] },
				{ calls: [{ id: "", name: "read", args: { path: "src/d.ts" }, result: "delta body" }] },
			],
			["a.ts alpha", "d.ts gamma"],
		);
		// A reused id: the first result belongs to the first call (a.ts), not to the last call with that id.
		expect(replies[0]).toMatch(/1 entry matches/);
		expect(hitLine(replies[0], ids[0].results['read:{"path":"src/a.ts"}'])).toBeDefined();
		// Empty ids pair nothing: the c.ts result is not read as d.ts's.
		expect(replies[1]).toMatch(/no entry has every word/);
	});

	it("F4: a result matched only through its call is left out when its call is listed", async () => {
		const { replies, ids } = await branchSearch(
			[
				{
					calls: [
						{
							id: "w1",
							name: "write",
							args: { path: "notes.md", content: "the zebra crossing is closed" },
							result: "Successfully wrote 28 bytes to notes.md",
						},
					],
				},
			],
			["zebra"],
		);
		const result = ids[0].results['write:{"path":"notes.md","content":"the zebra crossing is closed"}'];
		expect(replies[0]).toMatch(/1 entry matches/);
		expect(hitLine(replies[0], ids[0].call)).toContain(`· result: ${result} ·`);
		expect(hitLine(replies[0], result)).toBeUndefined();
	});

	it("F3: a hit on a call names only the results of the calls that matched", async () => {
		const { replies, ids } = await branchSearch(
			[
				{
					calls: [
						{ id: "c1", name: "read", args: { path: "src/a.ts" }, result: "alpha body" },
						{ id: "c2", name: "read", args: { path: "src/b.ts" }, result: "beta body" },
					],
				},
			],
			["b.ts"],
		);
		const a = ids[0].results['read:{"path":"src/a.ts"}'];
		const b = ids[0].results['read:{"path":"src/b.ts"}'];
		const line = hitLine(replies[0], ids[0].call) ?? "";
		expect(line).toContain(`· result: ${b} ·`);
		expect(line).not.toContain(a);
	});
});

describe("D16 follow-ups (review round 3)", () => {
	it("N5: the results of matched calls are named most words first", async () => {
		const { replies, ids } = await branchSearch(
			[
				{
					calls: [
						{ id: "c1", name: "read", args: { path: "src/a.ts" }, result: "alpha body" },
						{ id: "c2", name: "read", args: { path: "src/b.ts" }, result: "beta body" },
					],
				},
			],
			["src b.ts"],
		);
		const a = ids[0].results['read:{"path":"src/a.ts"}'];
		const b = ids[0].results['read:{"path":"src/b.ts"}'];
		expect(hitLine(replies[0], ids[0].call)).toContain(`· result: ${b}, ${a} ·`);
	});

	it("N7: calls with the same id in one message pair with their results first in, first out", async () => {
		const { replies, ids } = await branchSearch(
			[
				{
					calls: [
						{ id: "x", name: "read", args: { path: "src/a.ts" }, result: "alpha body" },
						{ id: "x", name: "read", args: { path: "src/b.ts" }, result: "beta body" },
					],
				},
			],
			["a.ts alpha", "b.ts beta"],
		);
		expect(replies[0]).toMatch(/1 entry matches/);
		expect(hitLine(replies[0], ids[0].results['read:{"path":"src/a.ts"}'])).toBeDefined();
		expect(replies[1]).toMatch(/1 entry matches/);
		expect(hitLine(replies[1], ids[0].results['read:{"path":"src/b.ts"}'])).toBeDefined();
	});

	it("N7 (round 4): a call that never got a result does not take the next result with its id", async () => {
		const { replies, ids } = await branchSearch(
			[
				{ calls: [{ id: "x", name: "read", args: { path: "src/a.ts" } }] },
				{ calls: [{ id: "x", name: "read", args: { path: "src/b.ts" }, result: "beta body" }] },
			],
			["b.ts beta", "a.ts beta"],
		);
		const result = ids[1].results['read:{"path":"src/b.ts"}'];
		// The result pairs with its own call (b.ts), not the unanswered one before it (a.ts).
		expect(hitLine(replies[0], result), replies[0]).toBeDefined();
		// a.ts and beta are not one entry's words: the result has only beta (the parent matched both through a.ts).
		expect(replies[1], replies[1]).toMatch(/no entry has every word/);
		expect(hitLine(replies[1], result)).toContain("1 of 2 words");
	});

	it("N8: an assistant message is searched by its calls' argument values, not name({json})", async () => {
		const { replies, ids } = await branchSearch(
			[{ calls: [{ id: "r1", name: "read", args: { path: "src/a.ts" }, result: "alpha body" }] }],
			["path alpha", "read alpha", "a.ts"],
		);
		// "path" (a key) and "read" (the tool name) do not make the calling message a hit.
		expect(hitLine(replies[0], ids[0].call)).toBeUndefined();
		expect(hitLine(replies[1], ids[0].call)).toBeUndefined();
		// The value does.
		expect(hitLine(replies[2], ids[0].call)).toBeDefined();
	});
});
