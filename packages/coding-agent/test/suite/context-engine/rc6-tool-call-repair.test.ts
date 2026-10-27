/**
 * RC6: a provider tool call with no id and no name (seen with GLM-5.3-Flash through OpenRouter). Pi records it
 * and answers it with "Tool  not found" under an empty tool_call_id, which a strict provider rejects with a 400
 * on every later request. The engine repairs what it sends: the call becomes a note, its result is left out, and
 * the session file keeps the raw entries. A call with a real name and no id gets an id made from the stored
 * message, on the call and on its result. The repaired request is the same on every later request, and the
 * request estimate and the appended estimate count the repaired request (as D17).
 */

import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats, serializedParts } from "./engine.ts";
import { finalTurn, scriptedModel, workExtension } from "./helpers.ts";

const NOTE = "[a tool call with no name was removed from this request]";

/** Stock s01 of the 0.5.0 bench (r2), trimmed: its broken call (entry 96b6f211) and the 12 requests after it. */
const S01 = fileURLToPath(new URL("./samples/s01-empty-tool-call.jsonl", import.meta.url));

/**
 * What a strict provider checks (the rules OpenRouter's 400 names): every tool call has an id and a name and is
 * answered, every tool result has an id that answers a call before it, and no id is used twice.
 */
function strictProblems(request: string[]): string[] {
	const problems: string[] = [];
	const calls = new Set<string>();
	const answered = new Set<string>();
	for (const [index, text] of request.entries()) {
		const message = JSON.parse(text) as { role: string; content?: unknown; toolCallId?: string };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as Array<{ type: string; id?: string; name?: string }>) {
				if (block.type !== "toolCall") continue;
				if (!block.id?.trim()) problems.push(`message ${index}: a tool call with no id`);
				if (!block.name?.trim()) problems.push(`message ${index}: a tool call with no name`);
				if (block.id && calls.has(block.id)) problems.push(`message ${index}: duplicate id ${block.id}`);
				if (block.id) calls.add(block.id);
			}
		}
		if (message.role === "toolResult") {
			const id = message.toolCallId ?? "";
			if (!id.trim()) problems.push(`message ${index}: a tool result with no tool_call_id`);
			else if (!calls.has(id)) problems.push(`message ${index}: result ${id} answers no call`);
			answered.add(id);
		}
	}
	for (const id of calls) if (!answered.has(id)) problems.push(`call ${id} is not answered`);
	return problems;
}

describe("RC6: a broken tool call is repaired in the request", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(sessionManager?: SessionManager) {
		const dir = mkdtempSync(join(tmpdir(), "ce-rc6-"));
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			sessionManager: sessionManager ?? SessionManager.create(dir, dir),
			extensionFactories: [workExtension, createContextEngine({ stats, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { stats, lines, harness, model: scriptedModel(harness) };
	}

	/** The session file's message entries, as recorded. */
	const recorded = (h: Harness) =>
		readFileSync(h.sessionManager.getSessionFile()!, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: Record<string, unknown> })
			.flatMap((entry) => (entry.type === "message" && entry.message ? [entry.message] : []));

	/** The engine's count of messages for the faux model, recounted from what the provider received. */
	const recount = (h: Harness, messages: Array<string | Record<string, unknown>>) => {
		const model = h.getModel();
		const target = { api: String(model.api), provider: model.provider, modelId: model.id, thinkingAsText: false };
		return messages.reduce<number>(
			(sum, m) => sum + serializedParts((typeof m === "string" ? JSON.parse(m) : m) as never, target).tokens,
			0,
		);
	};

	it("rc6 a call with no id and no name: the next request is valid and stays the same; the session keeps it", async () => {
		const h = await setup();
		h.model.push(
			() =>
				fauxAssistantMessage([fauxText("Looking."), fauxToolCall("", {}, { id: "" })], { stopReason: "toolUse" }),
			finalTurn("Done."),
		);
		await h.harness.session.prompt("Fix the parser.");
		h.model.push(finalTurn("Next done."));
		await h.harness.session.prompt("And the lexer.");

		// The request after the broken reply, and the one after the next prompt.
		expect(h.model.requests).toHaveLength(3);
		const [first, repaired, next] = h.model.requests;
		expect(strictProblems(repaired)).toEqual([]);
		expect(strictProblems(next)).toEqual([]);
		expect(repaired.some((m) => m.includes(NOTE))).toBe(true);
		expect(repaired.some((m) => m.includes("Tool  not found"))).toBe(false);
		// The second request repeats the first repaired one byte for byte (the prompt cache holds).
		expect(next.slice(0, repaired.length)).toEqual(repaired);

		// The session file keeps the raw call and Pi's answer to it.
		const messages = recorded(h.harness);
		const call = messages.find((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"toolCall"'));
		expect((call?.content as Array<Record<string, unknown>>).find((b) => b.type === "toolCall")).toMatchObject({
			id: "",
			name: "",
		});
		const raw = messages.find((m) => m.role === "toolResult" && m.toolCallId === "");
		expect(raw).toBeDefined();

		// D17: the request estimate is of what was sent, request by request.
		expect(h.stats.sent.map((s) => s.estimate)).toEqual(h.model.requests.map((r) => recount(h.harness, r)));
		// The appended estimate counts the repaired message, not the raw call and its result.
		const appended = recount(h.harness, repaired.slice(first.length));
		expect(h.stats.sent[1].appended).toBe(appended);
		expect(recount(h.harness, [call!, raw!])).not.toBe(appended);

		expect(h.stats.toolCallRepairs).toBe(2);
		expect(h.lines.filter((l) => l.includes("tool-call repair (no-name)"))).toHaveLength(1);
	});

	it("rc6 a call with a real name and no id: the tool's output is kept under one stable id", async () => {
		const h = await setup();
		h.model.push(
			() =>
				fauxAssistantMessage([fauxToolCall("work", { size: 40, seed: 3 }, { id: "" })], { stopReason: "toolUse" }),
			finalTurn("Done."),
		);
		await h.harness.session.prompt("Run it.");
		h.model.push(finalTurn("Again."));
		await h.harness.session.prompt("Once more.");

		const [, repaired, next] = h.model.requests;
		expect(strictProblems(repaired)).toEqual([]);
		const result = repaired.map((m) => JSON.parse(m)).find((m) => m.role === "toolResult");
		expect(result.toolCallId).toMatch(/^penpi_\d+_0$/);
		expect(result.toolName).toBe("work");
		expect(next.slice(0, repaired.length)).toEqual(repaired);
		expect(h.stats.sent.map((s) => s.estimate)).toEqual(h.model.requests.map((r) => recount(h.harness, r)));
		expect(h.lines.filter((l) => l.includes("tool-call repair (no-id)"))).toHaveLength(1);
	});

	it("rc6 a session with valid tool calls is sent unchanged", async () => {
		const h = await setup();
		h.model.push(
			() =>
				fauxAssistantMessage([fauxToolCall("work", { size: 40, seed: 4 }, { id: "call-4" })], {
					stopReason: "toolUse",
				}),
			finalTurn("Done."),
		);
		await h.harness.session.prompt("Run it.");
		expect(strictProblems(h.model.requests.at(-1)!)).toEqual([]);
		expect(h.stats.toolCallRepairs).toBe(0);
		expect(h.lines.some((l) => l.includes("tool-call repair"))).toBe(false);
	});

	it("rc6 stock s01: all 12 requests after the broken call are valid, and the session file keeps its entries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ce-rc6-s01-"));
		const file = join(dir, "s01.jsonl");
		copyFileSync(S01, file);
		const original = readFileSync(file, "utf8");
		const h = await setup(SessionManager.open(file));
		const entries = h.harness.sessionManager.getEntries();
		const at = (id: string) => entries.findIndex((e) => e.id === id);
		// The 12 requests s01 made after its broken call: Pi's continuation after the "Tool  not found" result,
		// then one per user prompt (each sent after the failed request before it).
		const users = entries.slice(at("9dd88fd7")).filter((e) => e.type === "message" && e.message.role === "user");
		expect(users).toHaveLength(11);
		h.model.push(...Array.from({ length: 12 }, () => finalTurn("ok")));

		await h.harness.session.navigateTree("9dd88fd7");
		await h.harness.session.agent.continue();
		for (const user of users) {
			const { editorText } = await h.harness.session.navigateTree(user.id);
			await h.harness.session.prompt(editorText!);
		}

		expect(h.model.requests).toHaveLength(12);
		for (const request of h.model.requests) {
			expect(strictProblems(request)).toEqual([]);
			expect(request.some((m) => m.includes(NOTE))).toBe(true);
			expect(request.some((m) => m.includes("Tool  not found"))).toBe(false);
		}
		// The session file: the recorded entries are unchanged (the replies above are appended after them).
		expect(readFileSync(file, "utf8").startsWith(original)).toBe(true);
	});
});
