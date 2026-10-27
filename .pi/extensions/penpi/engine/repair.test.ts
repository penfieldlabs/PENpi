import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./estimator.ts";
import { NOTE_NO_NAME, noteNoId, repairToolCalls } from "./repair.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;

const call = (id: string, name: string) => ({ type: "toolCall" as const, id, name, arguments: {} });

const assistant = (content: unknown[], timestamp = 1000): AgentMessage =>
	({
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
		stopReason: "toolUse",
		timestamp,
	}) as AgentMessage;

const result = (toolCallId: string, toolName: string, text = "out", isError = false): AgentMessage =>
	({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	}) as AgentMessage;

/** Stock s01, r2 (lines 268 and 269): a thinking block and a call with no id and no name, then Pi's answer. */
const s01 = (): AgentMessage[] => [
	user("Fix the parser."),
	assistant([{ type: "thinking", thinking: "Let me look." }, call("", "")], 1700),
	result("", "", "Tool  not found", true),
];

const contentOf = (message: AgentMessage) =>
	(message as unknown as { content: Array<Record<string, unknown>> }).content;

describe("tool-call repair (RC6)", () => {
	it("the notes are short and neutral, with no instruction to the model", () => {
		expect(NOTE_NO_NAME).toBe("[a tool call with no name was removed from this request]");
		expect(noteNoId("bash")).toBe("[a call to bash with no id was removed from this request, with its result]");
	});

	it("s01's shape: the call becomes the note, the result is dropped, the thinking block stays", () => {
		const input = s01();
		const { messages, kinds } = repairToolCalls(input);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toBe(input[0]);
		expect(contentOf(messages[1])).toEqual([
			{ type: "thinking", thinking: "Let me look." },
			{ type: "text", text: NOTE_NO_NAME },
		]);
		expect(kinds).toEqual(["no-name"]);
	});

	it("rule 1 with an id: a call with an id and no name is replaced, and its result is dropped", () => {
		const { messages, kinds } = repairToolCalls([
			user("Go."),
			assistant([call("call_1", " ")]),
			result("call_1", " ", "Tool   not found", true),
		]);
		expect(messages).toHaveLength(2);
		expect(contentOf(messages[1])).toEqual([{ type: "text", text: NOTE_NO_NAME }]);
		expect(kinds).toEqual(["no-name"]);
	});

	it("a real call and a bad one in one message: the real pair is kept as it is", () => {
		const input = [
			user("Go."),
			assistant([{ type: "text", text: "Two calls." }, call("call_1", "read"), call("", "")]),
			result("call_1", "read", "file text"),
			result("", "", "Tool  not found", true),
			user("Next."),
		];
		const { messages } = repairToolCalls(input);
		expect(messages).toHaveLength(4);
		expect(contentOf(messages[1])).toEqual([
			{ type: "text", text: "Two calls." },
			call("call_1", "read"),
			{ type: "text", text: NOTE_NO_NAME },
		]);
		expect(messages[2]).toBe(input[2]);
		expect(messages[3]).toBe(input[4]);
	});

	it("several calls with no name give one note", () => {
		const { messages } = repairToolCalls([
			user("Go."),
			assistant([call("", ""), call("", "")]),
			result("", "", "Tool  not found", true),
			result("", "", "Tool  not found", true),
		]);
		expect(messages).toHaveLength(2);
		expect(contentOf(messages[1])).toEqual([{ type: "text", text: NOTE_NO_NAME }]);
	});

	it("rule 2: a real name and no id: the call and its result get the same id, made from the message", () => {
		const input = [
			user("Go."),
			assistant([call("call_1", "read"), call("", "bash")], 1234),
			result("call_1", "read"),
			result("", "bash", "ls output"),
		];
		const { messages, kinds } = repairToolCalls(input);
		expect(messages).toHaveLength(4);
		expect(contentOf(messages[1])[1]).toEqual(call("penpi_1234_1", "bash"));
		expect((messages[3] as { toolCallId: string }).toolCallId).toBe("penpi_1234_1");
		expect(contentOf(messages[3])).toEqual([{ type: "text", text: "ls output" }]);
		expect(messages[2]).toBe(input[2]);
		expect(kinds).toEqual(["no-id"]);
		// The same input gives the same id on every request.
		expect(repairToolCalls(input).messages).toEqual(messages);
	});

	it("two calls with a real name and no id pair with the two empty-id results first in, first out", () => {
		const { messages } = repairToolCalls([
			user("Go."),
			assistant([call("", "read"), call("", "bash")], 1234),
			result("", "read", "file"),
			result("", "bash", "ls"),
		]);
		expect(contentOf(messages[1])).toEqual([call("penpi_1234_0", "read"), call("penpi_1234_1", "bash")]);
		expect(messages.slice(2).map((m) => [(m as { toolCallId: string }).toolCallId, contentOf(m)[0].text])).toEqual([
			["penpi_1234_0", "file"],
			["penpi_1234_1", "ls"],
		]);
	});

	it("a named call with no id whose result comes after another call's result, in either order", () => {
		for (const results of [
			[result("call_1", "read"), result("", "bash", "ls")],
			[result("", "bash", "ls"), result("call_1", "read")],
		]) {
			const { messages } = repairToolCalls([
				user("Go."),
				assistant([call("call_1", "read"), call("", "bash")], 7),
				...results,
			]);
			expect(contentOf(messages[1])).toEqual([call("call_1", "read"), call("penpi_7_1", "bash")]);
			const byId = Object.fromEntries(messages.slice(2).map((m) => [(m as { toolCallId: string }).toolCallId, m]));
			expect(Object.keys(byId).sort()).toEqual(["call_1", "penpi_7_1"]);
			expect(contentOf(byId.penpi_7_1)[0].text).toBe("ls");
		}
	});

	it("two empty-id calls whose results do not match by name: both become notes and both results are dropped", () => {
		const { messages, kinds } = repairToolCalls([
			user("Go."),
			assistant([call("", "read"), call("", "bash")]),
			result("", "bash"),
			result("", "read"),
		]);
		expect(messages).toHaveLength(2);
		expect(contentOf(messages[1])).toEqual([
			{ type: "text", text: noteNoId("read") },
			{ type: "text", text: noteNoId("bash") },
		]);
		expect(kinds).toEqual(["no-id-unpaired"]);
	});

	it("a repaired id the request already uses is not given twice: that call falls back to the note", () => {
		const { messages } = repairToolCalls([
			user("Go."),
			assistant([call("penpi_5_0", "read")], 4),
			result("penpi_5_0", "read"),
			assistant([call("", "bash")], 5),
			result("", "bash"),
		]);
		expect(messages).toHaveLength(4);
		expect(contentOf(messages[3])).toEqual([{ type: "text", text: noteNoId("bash") }]);
	});

	it("rule 2's fallback: a result that does not match by name: the call becomes a note, the result is dropped", () => {
		const { messages, kinds } = repairToolCalls([
			user("Go."),
			assistant([call("", "bash")]),
			result("", "read", "other"),
		]);
		expect(messages).toHaveLength(2);
		expect(contentOf(messages[1])).toEqual([{ type: "text", text: noteNoId("bash") }]);
		expect(kinds).toEqual(["no-id-unpaired"]);
	});

	it("rule 2's fallback: no result at all (the run ended at the call)", () => {
		const { messages } = repairToolCalls([user("Go."), assistant([call("", "bash")])]);
		expect(contentOf(messages[1])).toEqual([{ type: "text", text: noteNoId("bash") }]);
	});

	it("rule 3: a result with an empty id that answers no call is dropped", () => {
		const input = [user("Go."), assistant([call("call_1", "read")]), result("call_1", "read"), result("", "read")];
		const { messages, kinds } = repairToolCalls(input);
		expect(messages).toEqual(input.slice(0, 3));
		expect(kinds).toEqual(["orphan-result"]);
	});

	it("a normal list comes back as the same array, with no kinds", () => {
		const input = [
			user("Go."),
			assistant([{ type: "text", text: "Reading." }, call("call_1", "read"), call("call_2", "bash")]),
			result("call_1", "read"),
			result("call_2", "bash"),
			assistant([{ type: "text", text: "Done." }]),
			{ role: "custom", customType: "x", content: "c", display: false, timestamp: 3 } as AgentMessage,
		];
		const repaired = repairToolCalls(input);
		expect(repaired.messages).toBe(input);
		expect(repaired.kinds).toEqual([]);
		expect(repairToolCalls([]).messages).toEqual([]);
	});

	it("is pure: the input is not changed, and two runs give equal output", () => {
		const input = s01();
		const before = JSON.stringify(input);
		const first = repairToolCalls(input);
		const second = repairToolCalls(input);
		expect(JSON.stringify(input)).toBe(before);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.messages).not.toBe(input);
	});

	it("a repaired list is not repaired again", () => {
		const once = repairToolCalls(s01()).messages;
		expect(repairToolCalls(once).messages).toBe(once);
	});
});
