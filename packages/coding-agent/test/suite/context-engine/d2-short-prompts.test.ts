/**
 * D2 and D10: short prompts. With the user-message pin (the default), a short run prompt ("now do the tests
 * too") and the long task before it are both user messages: the task is carried verbatim, the short prompt
 * is the current request (labelled once it has left the window), and the pinned-task and
 * latest-instruction tags do not appear. The next long prompt becomes the current request; the earlier two
 * stay carried, labelled already handled (D26), in order. With the pin off, every prompt is one run record (D10), so the short
 * prompt becomes the pinned task and there is no latest instruction.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const TASK_A = "Task A: migrate the parser module to the v2 grammar and keep the old API working.";
const SHORT = "now do the tests too";
const TASK_C = "Task C: add streaming to the exporter and document the new command-line flags.";

/** The pin of the last window header seen in `requests`: carried texts, the one labelled current, r5 tags. */
function lastPin(
	requests: string[][],
): { carried: string[]; current?: string; r5Tags: boolean; seq?: number } | undefined {
	for (let i = requests.length - 1; i >= 0; i--) {
		const raw = requests[i].find((m) => m.includes("[context window #"));
		if (!raw) continue;
		const m = JSON.parse(raw) as { content: string | Array<{ text?: string }> };
		const text = typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("\n");
		const carried = [...text.matchAll(/--- user message \S+(?: \([^)]*\))? ---\n([^\n]*)/g)].map((x) => x[1]);
		return {
			carried,
			current: text.match(/--- user message \S+ \((?:sent \d{4}-\d\d-\d\d; )?current request\) ---\n([^\n]*)/)?.[1],
			r5Tags: text.includes("<pinned-task>") || text.includes("<latest-instruction>"),
			seq: Number(text.match(/\[context window #(\d+)\]/)?.[1]),
		};
	}
	return undefined;
}

describe("D2: short prompts under the user-message pin", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(engine: { pinUserMessages?: null } = {}) {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, ...engine })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { stats, harness, model: scriptedModel(harness) };
	}

	it("d2 a short prompt is carried as the current request with the earlier task still pinned; a long prompt takes over", async () => {
		const { stats, harness, model } = await setup();
		const pins: Array<ReturnType<typeof lastPin> & { prompt: string; cutsDuring: number }> = [];
		let seedBase = 0;
		for (const prompt of [TASK_A, SHORT, TASK_C]) {
			const from = model.requests.length;
			const cutsBefore = stats.cuts.length;
			await runPrompts(harness, model, {
				prompts: 1,
				turns: 25,
				min: 2_000,
				prompt: () => prompt,
				seedBase,
				seed: seedBase + 1,
			});
			seedBase += 100;
			pins.push({ prompt, cutsDuring: stats.cuts.length - cutsBefore, ...lastPin(model.requests.slice(from))! });
		}
		report("d2", ENGINE_LABEL, "p3-sequence", pins);
		expect(pins.every((h) => h.cutsDuring > 0)).toBe(true);
		expect(pins.every((h) => !h.r5Tags)).toBe(true);
		expect(pins[0]).toMatchObject({ current: TASK_A });
		expect(pins[1].current).toBe(SHORT);
		expect(pins[1].carried).toEqual([TASK_A, SHORT]);
		expect(pins[2].current).toBe(TASK_C);
		expect(pins[2].carried).toEqual([TASK_A, SHORT, TASK_C]);
	});

	it("d2 a short first prompt is the current request", async () => {
		const { stats, harness, model } = await setup();
		await runPrompts(harness, model, { prompts: 1, turns: 30, prompt: () => "fix the build" });
		const pin = lastPin(model.requests);
		report("d2", ENGINE_LABEL, "p3-short-first", { cuts: stats.cuts.length, pin });
		expect(stats.cuts.length).toBeGreaterThan(0);
		expect(pin).toMatchObject({ current: "fix the build", carried: ["fix the build"], r5Tags: false });
	});

	it("d10 with the pin off, a short prompt becomes the pinned task and there is no latest instruction", async () => {
		const { stats, harness, model } = await setup({ pinUserMessages: null });
		let seedBase = 0;
		for (const prompt of [TASK_A, SHORT]) {
			await runPrompts(harness, model, {
				prompts: 1,
				turns: 25,
				min: 2_000,
				prompt: () => prompt,
				seedBase,
				seed: seedBase + 1,
			});
			seedBase += 100;
		}
		expect(stats.cuts.length).toBeGreaterThan(1);
		const header = [...model.requests.at(-1)!].find((m) => m.includes("[context window #"));
		expect(header).toBeDefined();
		const text = JSON.parse(header!).content;
		const body =
			typeof text === "string" ? text : (text as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
		expect(body).toMatch(new RegExp(`<pinned-task>\\s*${SHORT}\\s*</pinned-task>`));
		expect(body).not.toContain("<latest-instruction>");
	});
});
