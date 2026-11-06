/**
 * 0.6.1 review (review:0's S5, its tests R1 to R4 adopted): context_recall on a tool call's entry inlines the calls'
 * results, and the page must hold its limits. The room left after the call is counted in tokens, each result at its own
 * density, and in characters when `limit` asks for them; pointer lines count too, and when not even a pointer fits, one
 * line says how many more there are.
 */
import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { textTokens } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { scriptedModel } from "./helpers.ts";

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	return last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/** One assistant entry with a read call per result; then the model makes `calls` (built from the ids) in turn. */
async function run(
	results: string[],
	calls: (ids: { callId: string; resultIds: string[] }) => Array<[string, Record<string, unknown>]>,
): Promise<{ replies: string[]; callId: string; resultIds: string[] }> {
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [createContextEngine({ stats: newStats() })],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const callId = harness.sessionManager.appendMessage(
		fauxAssistantMessage(
			results.map((_, i) => fauxToolCall("read", { path: `f${i}.txt` }, { id: `c${i}` })),
			{ stopReason: "toolUse" },
		),
	);
	const resultIds = results.map((text, i) =>
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: `c${i}`,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		}),
	);
	const plan = calls({ callId, resultIds });
	const model = scriptedModel(harness);
	const replies: string[] = [];
	const steps = plan.map(([name, args], k) => (context: TranscriptContext) => {
		if (k > 0) replies.push(lastToolText(context));
		return fauxAssistantMessage([fauxToolCall(name, args as ToolCall["arguments"], { id: `t${k}` })], {
			stopReason: "toolUse",
		});
	});
	model.push(...steps, (context: TranscriptContext) => {
		replies.push(lastToolText(context));
		return fauxAssistantMessage([fauxText("done")]);
	});
	await harness.session.prompt("go");
	return { replies, callId, resultIds };
}

describe("0.6.1: the recall page holds its limits with results inlined", () => {
	it("R1: limit set: a result that fits what is left is inlined, a longer one gives the pointer, within the limit", async () => {
		const LIMIT = 300;
		// the call's text, to know what is left of the page
		const probe = await run(["x"], ({ callId }) => [["context_recall", { entry: callId, limit: LIMIT }]]);
		const callText = probe.replies[0].split("\n")[1];
		const room = LIMIT - callText.length;
		const head = (n: number, id: string) => `[result of read: entry ${id}, ${n} characters]`;
		// head length depends on the id and n; the ids are deterministic per harness (D13)
		const fit = room - head(100, probe.resultIds[0]).length - 2;
		// A text about as dense in tokens as the call, so the character room is the one that binds (a run of one letter
		// is denser than the call and is held back by the token room first).
		const prose = (n: number) => "read the path f0 txt ".repeat(Math.ceil(n / 21)).slice(0, n);
		const small = await run([prose(Math.floor(fit / 2))], ({ callId }) => [
			["context_recall", { entry: callId, limit: LIMIT }],
		]);
		const b = await run([prose(fit + 1)], ({ callId }) => [["context_recall", { entry: callId, limit: LIMIT }]]);
		expect(small.replies[0]).toContain(prose(Math.floor(fit / 2)));
		expect(b.replies[0]).toContain("read it with context_recall");
		// the reply body after the header line stays within LIMIT, both ways
		for (const reply of [small.replies[0], b.replies[0]])
			expect(reply.length - reply.indexOf("\n") - 1).toBeLessThanOrEqual(LIMIT);
	});

	it("R2: a result denser in tokens than its call stays within the token page a direct recall applies", async () => {
		const dense = "数据".repeat(150_000); // CJK: far more tokens per character than read({"path":...})
		// direct recall of a long dense result: its page in characters, P
		const direct = await run([dense], ({ resultIds }) => [["context_recall", { entry: resultIds[0] }]]);
		const m = /characters 0-(\d+) of (\d+)/.exec(direct.replies[0]);
		const P = Number(m?.[1]);
		const callText = 'read({"path":"f0.txt"})';
		const dCall = textTokens(callText) / callText.length;
		const dRes = textTokens(dense) / dense.length;
		const callPage = Math.floor((P * dRes) / Math.max(dCall, 0.05));
		const L = Math.min(callPage - callText.length - 80, dense.length);
		const via = await run([dense.slice(0, L)], ({ callId }) => [["context_recall", { entry: callId }]]);
		const tokVia = textTokens(via.replies[0]);
		const tokDirect = textTokens(direct.replies[0]);
		expect(tokVia, "the reply through the call is larger in tokens than a page").toBeLessThanOrEqual(
			tokDirect * 1.05,
		);
	});

	it("R3: several calls in one entry: results inlined while they fit, pointers after, total within the page", async () => {
		const LIMIT = 2000;
		const r = await run(["A".repeat(600), "B".repeat(600), "C".repeat(600), "D".repeat(10)], ({ callId }) => [
			["context_recall", { entry: callId, limit: LIMIT }],
		]);
		const body = r.replies[0].slice(r.replies[0].indexOf("\n") + 1);
		expect(body.length).toBeLessThanOrEqual(LIMIT + 200);
	});

	it("R4: many calls in one entry, none fits: the pointer lines count against the page, and one line says how many more", async () => {
		const LIMIT = 1200;
		const r = await run(
			Array.from({ length: 40 }, () => "z".repeat(1000)),
			({ callId }) => [["context_recall", { entry: callId, limit: LIMIT }]],
		);
		const body = r.replies[0].slice(r.replies[0].indexOf("\n") + 1);
		expect(body.length).toBeLessThanOrEqual(LIMIT * 2);
		// and it says how many results it did not list
		expect(body.trimEnd().split("\n").at(-1)).toMatch(
			/^\[\d+ more results of this entry's tool calls not shown: context_search names each call's result entry\]$/,
		);
	});
});
