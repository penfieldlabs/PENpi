/**
 * 0.9.0, design section 5: the reasoning rules (engine/tokenizers/reasoning.ts), each tested against the templates it
 * was read from, rendered (jinja-lite.ts), not against a description of them. The templates come from
 * `npm run setup:tokenizers` (context-engine-e2/fetch-templates.ts), each at its pinned revision and SHA-256; a test
 * whose template isn't fetched is skipped.
 *
 * - **The rule:** each template renders a Pi-shaped conversation twice: tools, a tool-call turn, a final answer, a second
 *   user message and another tool-call turn; and the same without the final answer. Which turns' reasoning survives
 *   gives the rule: every turn's (keep), none (none), only after the last user message (drop), or after the last final
 *   answer (after-final; with gpt-oss's tool-call text gone too, after-final-text).
 * - **The absolute bound's premise:** the bound counts the system prompt, user text and tool-result text, trimmed, and an
 *   honest provider never reports less. So no template may rewrite those texts beyond a trim. Each template renders a
 *   long tool-call argument (a file write), an assistant message quoting `</think>` and a tool result ending in 2,000
 *   newlines, and the user and tool-result texts must appear in the rendering, whole once trimmed.
 * - **The ids:** each rule's example catalogue ids land on it, the first match winning.
 * - **Template tokens:** gpt-oss's harmony template, counted with o200k (bundled, so the suite can count it), stays within
 *   the exact rules' tolerance with its pinned tokens per call and argument, on appends of tool calls with one to three
 *   arguments and two calls in a turn. The other families were measured the same way with their own tokenizers.
 */

import { describe, expect, it } from "vitest";
import { exactTolerance } from "../../../../../.pi/extensions/penpi/engine/detector.ts";
import {
	pinnedRule,
	REASONING_RULES,
	reasoningRule,
} from "../../../../../.pi/extensions/penpi/engine/tokenizers/reasoning.ts";
import { cachedTemplate } from "../context-engine-e2/fetch-templates.ts";
import { renderTemplate } from "./jinja-lite.ts";
import { o200kTokens } from "./tokenizers.ts";

type Msg = Record<string, unknown>;
const tools = [
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
];
/** An assistant turn, with its reasoning under every name a template reads it by. */
const assistant = (text: string, reasoning: string, call?: { id: string; args: Msg }): Msg => ({
	role: "assistant",
	content: text,
	reasoning_content: reasoning,
	reasoning,
	thinking: reasoning,
	...(call
		? { tool_calls: [{ id: call.id, type: "function", function: { name: "read", arguments: call.args } }] }
		: {}),
});
const tool = (id: string, text: string): Msg => ({ role: "tool", tool_call_id: id, name: "read", content: text });
// Tool-call ids of 9 characters: Mistral's templates refuse others.
const A: Msg[] = [
	{ role: "system", content: "SYSTEXT" },
	{ role: "user", content: "USERONE" },
	assistant("TXTONE", "RSNONE", { id: "call00001", args: { path: "a.txt" } }),
	tool("call00001", "OUTONE"),
	assistant("TXTTWO", "RSNTWO"),
	{ role: "user", content: "USERTWO" },
	assistant("TXTTHREE", "RSNTHREE", { id: "call00002", args: { path: "b.txt" } }),
	tool("call00002", "OUTTWO"),
];
const B: Msg[] = [A[0], A[1], A[2], A[3], A[5], A[6], A[7]];

const render = (template: string, messages: Msg[]) =>
	renderTemplate(template, { messages, tools, add_generation_prompt: true, bos_token: "<s>", eos_token: "</s>" });

/** gpt-oss refuses a tool-call turn with both text and thinking: the probe then sends the thinking alone. */
const thinkingOnly = (ms: Msg[]) => ms.map((m) => (m.role === "assistant" && m.tool_calls ? { ...m, content: "" } : m));
const textOnly = (ms: Msg[]) =>
	ms.map((m) =>
		m.role === "assistant" && m.tool_calls
			? { ...m, reasoning_content: undefined, reasoning: undefined, thinking: undefined }
			: m,
	);

/** The rule a template renders, from which turns' reasoning survives. */
function ruleOf(template: string): string {
	let a: string;
	let b: string;
	let text: string | undefined;
	try {
		a = render(template, A);
		b = render(template, B);
	} catch (error) {
		if (!/Cannot pass both content and thinking/.test((error as Error).message)) throw error;
		a = render(template, thinkingOnly(A));
		b = render(template, thinkingOnly(B));
		text = render(template, textOnly(A));
	}
	for (const kept of ["USERONE", "OUTONE", "TXTTWO", "USERTWO"])
		if (!a.includes(kept)) throw new Error(`the rendering lost ${kept}`);
	const r1 = a.includes("RSNONE");
	const r2 = a.includes("RSNTWO");
	const r3 = a.includes("RSNTHREE");
	if (r1 && r2 && r3) return "keep";
	if (!r1 && !r2 && !r3) return "none";
	if (!r1 && r3 && !b.includes("RSNONE")) return "drop";
	if (!r1 && r3 && b.includes("RSNONE"))
		return text === undefined
			? a.includes("TXTONE")
				? "after-final"
				: "after-final-text"
			: text.includes("TXTONE")
				? "after-final"
				: "after-final-text";
	return `unclear (keeps ${[r1 && "1", r2 && "2", r3 && "3"].filter(Boolean).join(", ")})`;
}

describe("0.9.0: reasoning rules, against the templates they were read from", () => {
	for (const pinned of REASONING_RULES)
		for (const t of pinned.templates) {
			const template = cachedTemplate(t);
			it.skipIf(template === undefined)(`${t.repo} renders "${pinned.rule}"`, () => {
				expect(ruleOf(template!)).toBe(pinned.rule);
			});
		}

	it("each rule's example catalogue ids land on it", () => {
		for (const pinned of REASONING_RULES)
			for (const id of pinned.examples) expect(reasoningRule(id), id).toBe(pinned.rule);
	});
});

describe("0.9.0: the absolute bound's premise, per template: user and tool-result text rendered whole, trimmed at most", () => {
	const write = "x".repeat(4_000);
	const longTool = `LONGTOOLRESULT\n${"\n".repeat(2_000)}`;
	const messages: Msg[] = [
		{ role: "system", content: "SYSTEXT" },
		{ role: "user", content: "Write the file, then read it.  " },
		{
			role: "assistant",
			content: "",
			tool_calls: [
				{
					id: "call00003",
					type: "function",
					function: { name: "read", arguments: { path: "w.txt", content: write } },
				},
			],
		},
		tool("call00003", longTool),
		{ role: "assistant", content: "It quotes </think> in its text, and goes on." },
		{ role: "user", content: "Thanks." },
	];
	const seen = new Set<string>();
	for (const pinned of REASONING_RULES)
		for (const t of pinned.templates) {
			if (seen.has(t.sha256)) continue;
			seen.add(t.sha256);
			const template = cachedTemplate(t);
			it.skipIf(template === undefined)(`${t.repo}`, () => {
				const rendered = render(template!, messages);
				for (const text of ["Write the file, then read it.", "LONGTOOLRESULT", "Thanks."])
					expect(rendered.includes(text), `${t.repo} rendered ${JSON.stringify(text)}`).toBe(true);
			});
		}
});

describe("0.9.0: template tokens around tool calls, within the tolerance (gpt-oss, on o200k)", () => {
	const OUT = "export const a = 1;\nexport function b(x: number) {\n\treturn x * 2;\n}\n";
	let k = 0;
	const call = (name: string, args: Msg): Msg => ({
		role: "assistant",
		content: "",
		reasoning_content: "I should look at the file first.",
		reasoning: "I should look at the file first.",
		thinking: "I should look at the file first.",
		tool_calls: [
			{ id: `call${String(++k).padStart(5, "0")}`, type: "function", function: { name, arguments: args } },
		],
	});
	const result = (m: Msg, text: string): Msg => {
		const c = (m.tool_calls as Msg[])[0] as { id: string; function: { name: string } };
		return { role: "tool", tool_call_id: c.id, name: c.function.name, content: text };
	};
	/** What the engine counts of an append: texts, reasoning, and each call's name and JSON arguments. */
	const counted = (ms: Msg[]) =>
		ms.reduce((n, m) => {
			if (m.role === "tool") return n + o200kTokens(String(m.name)) + o200kTokens(String(m.content));
			const calls = (m.tool_calls as Array<{ function: { name: string; arguments: Msg } }> | undefined) ?? [];
			return (
				n +
				(m.content ? o200kTokens(String(m.content)) : 0) +
				o200kTokens(String(m.reasoning_content)) +
				calls.reduce((t, c) => t + o200kTokens(`${c.function.name} ${JSON.stringify(c.function.arguments)}`), 0)
			);
		}, 0);
	const pinned = pinnedRule("openai/gpt-oss-120b")!;
	for (const t of pinned.templates) {
		const template = cachedTemplate(t);
		it.skipIf(template === undefined)(`${t.repo}`, () => {
			const first = call("read", { path: "src/a.ts" });
			const base: Msg[] = [
				{ role: "system", content: "SYSTEXT" },
				{ role: "user", content: "Look." },
				first,
				result(first, OUT),
			];
			const one = call("read", { path: "src/b.ts" });
			const two = call("write", { path: "src/c.ts", content: OUT });
			const three = call("bash", { command: "npm test", timeout: 120, description: "run the tests" });
			const pair = call("read", { path: "src/d.ts" });
			(pair.tool_calls as Msg[]).push({
				id: "call09999",
				type: "function",
				function: { name: "read", arguments: { path: "src/e.ts" } },
			});
			const appends: Array<[Msg[], number, number]> = [
				[[one, result(one, OUT)], 1, 1],
				[[two, result(two, "Wrote src/c.ts.")], 1, 2],
				[[three, result(three, "ok 12 tests")], 1, 3],
				[[pair, result(pair, OUT), { role: "tool", tool_call_id: "call09999", name: "read", content: OUT }], 2, 2],
			];
			const before = o200kTokens(render(template!, base));
			for (const [append, calls, args] of appends) {
				const surplus = o200kTokens(render(template!, [...base, ...append])) - before - counted(append);
				expect(surplus, JSON.stringify(append.map((m) => m.role))).toBeLessThanOrEqual(
					exactTolerance("o200k", append.length, pinned.templateTokens, calls, args),
				);
				// Without the pinned tokens, the template is over the entry's tolerance: the pin is needed.
				expect(surplus).toBeGreaterThan(exactTolerance("o200k", append.length));
			}
		});
	}
});
