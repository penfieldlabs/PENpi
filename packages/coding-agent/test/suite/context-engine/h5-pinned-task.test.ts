/**
 * H5, retargeted to the P3 pin (reviewer Change 1): the current request is identifiable after a cut.
 * Under r5 the header pinned the prompt that started the current run (<pinned-task>). With the
 * user-message pin (the shipping default) that prompt, once it has left the window, is carried in the
 * pin and labelled "current request"; earlier run prompts are carried too, labelled already handled (D26). The header is
 * rendered at a cut (it changes only there), so after a new prompt the previous one may still carry the
 * label until the next cut; the pin's wording says the label holds as of the cut and that a newer user
 * message supersedes it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const PROMPTS = [
	"Task A: migrate the parser to the v2 grammar.",
	"Task B: rewrite the tokenizer cache.",
	"Task C: add streaming to the exporter.",
	"Task D: fix the flaky retry tests in the scheduler.",
];

/** Provider-visible text of every message in a recorded request (messages are JSON strings). */
function texts(request: string[]): string[] {
	return request.map((raw) => {
		const m = JSON.parse(raw) as { content?: unknown; summary?: string };
		if (typeof m.summary === "string") return m.summary;
		if (typeof m.content === "string") return m.content;
		return Array.isArray(m.content)
			? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n")
			: "";
	});
}

describe("H5: the current request is identifiable after a cut", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const mode of ["a"] as const) {
		it(`h5 mode ${mode}: the latest run's prompt is labelled current request in the pin once it left the window`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [workExtension, createContextEngine({ mode, stats })],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const model = scriptedModel(harness);
			let current = "";
			const checked: Array<{ request: number; current: string; labelled: string[]; inWindow: boolean }> = [];
			const inner = harness.session.agent.streamFunction;
			// Each request: which prompt is current, whether it is still in the window as a user message, and
			// which pinned messages carry the label.
			harness.session.agent.streamFunction = (m, context, options) => {
				const t = context.messages.map((msg) => {
					const c = (msg as { content?: unknown }).content;
					return typeof c === "string"
						? c
						: Array.isArray(c)
							? (c as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n")
							: "";
				});
				const header = t.find((x) => x.includes("[context window #")) ?? "";
				const labelled = [
					...header.matchAll(/--- user message \S+ \((?:sent \d{4}-\d\d-\d\d; )?current request\) ---\n([^\n]*)/g),
				].map((x) => x[1]);
				const inWindow = context.messages.some((msg, i) => msg.role === "user" && t[i] === current);
				if (header) checked.push({ request: checked.length, current, labelled, inWindow });
				return inner(m, context, options);
			};
			await runPrompts(harness, model, {
				prompts: 4,
				turns: 25,
				prompt: (p) => {
					current = PROMPTS[p];
					return PROMPTS[p];
				},
			});
			const out = checked.filter((c) => !c.inWindow);
			report("h5", ENGINE_LABEL, `p3-${mode}`, {
				cuts: stats.cuts.length,
				requestsWithHeader: checked.length,
				currentOutOfWindow: out.length,
			});
			expect(stats.cuts.length).toBeGreaterThan(3);
			// The current request left the window in some requests, and then it was labelled, exactly once.
			expect(out.length).toBeGreaterThan(0);
			for (const c of out) expect(c.labelled).toEqual([c.current]);
			// While it is in the window, at most the previous run's prompt is labelled: the header is rendered at a
			// cut and only changes at the next one; its wording says the label is as of the cut, and a newer user
			// message supersedes it. The labelled one is never the current request then, and never a later prompt.
			for (const c of checked.filter((x) => x.inWindow)) {
				expect(c.labelled.length, JSON.stringify(c)).toBeLessThanOrEqual(1);
				for (const l of c.labelled)
					expect(PROMPTS.indexOf(l), JSON.stringify(c)).toBeLessThan(PROMPTS.indexOf(c.current));
			}
			// The last header still carries the earlier tasks, labelled already handled (D26), not current request.
			const last = texts(model.requests.at(-1) ?? []).find((x) => x.includes("[context window #")) ?? "";
			expect(last).toContain("<pinned-user-messages>");
			expect(last).not.toContain("<pinned-task>");
		});
	}
});
