/**
 * P2 (E4 2026-10-14, findings/standing-instructions-cut.md): standing user instructions must survive cuts.
 * With pinUserMessages on, the window header carries the user messages that left the window verbatim,
 * oldest first, capped at capFraction of the window: the first protectFirst messages and the newest are
 * dropped last, the middle first (pointer, then a range line); a long paste is a pointer. The pin replaces
 * the H5 pinned task (the run's prompt is the newest carried message once it has left the window); a task
 * set through context_notes stays pinned. Off (pinUserMessages: null) leaves the r5 header unchanged.
 *
 * P3 retargets (reviewer Change 1): the pin is on by default; the intro is the reviewer's wording; a
 * pointer carries the first 200 characters (whitespace collapsed); the current request (the latest
 * run's prompt) is labelled and pointered last, while the newest carried message that is not the current
 * request is middle (pointered after older middle messages).
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats, textTokens } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, syntheticText, toolTurn, workExtension } from "./helpers.ts";

const MODEL = { id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 };
const PIN = { capFraction: 0.1, protectFirst: 3, longMessageChars: 2_000 };
const RULES =
	"Ground rules for this repo, for the rest of the session: all new files must go under `src/zz-legacy-q7/`. " +
	"Never use the `fmtly` library. Every new source file must start with `// owner: team-kestrel-41`.";

/** The provider-visible text of the window header in a request, or "" before the first cut. */
function headerOf(request: string[]): string {
	for (const raw of request) {
		if (!raw.includes("[context window #")) continue;
		const m = JSON.parse(raw) as { content: string | Array<{ type: string; text?: string }> };
		return typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("\n");
	}
	return "";
}

function pinBlock(header: string): string {
	const a = header.indexOf("<pinned-user-messages>");
	const b = header.indexOf("</pinned-user-messages>");
	return a < 0 || b < 0 ? "" : header.slice(a, b + "</pinned-user-messages>".length);
}

describe("user-message pin", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		pin: typeof PIN | null,
		model: { id: string; contextWindow: number; maxTokens: number } = MODEL,
		windowCeiling?: number,
	) {
		const stats = newStats();
		const harness = await createHarness({
			models: [model],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				createContextEngine({ stats, pinUserMessages: pin, ...(windowCeiling ? { windowCeiling } : {}) }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		installProviderSim(harness);
		// Keep only the latest window header seen by the provider (long sessions: no full request copies).
		const seen = { header: "" };
		const agent = harness.session.agent;
		const inner = agent.streamFunction;
		agent.streamFunction = (m, context, options) => {
			for (const msg of context.messages) {
				if (msg.role === "system") continue;
				const c = msg.content as string | Array<{ type: string; text?: string }>;
				const text = typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n");
				if (text.includes("[context window #")) seen.header = text;
			}
			return inner(m, context, options);
		};
		const long = model !== MODEL;
		return { stats, harness, seen, model: scriptedModel(harness, long ? 8_000 : 4_000, { digest: long }) };
	}

	/** A prompt with `turns` tool turns of 4-6k characters each, then a final answer. */
	async function work(h: Awaited<ReturnType<typeof setup>>, prompt: string, turns: number, seed: number) {
		for (let t = 0; t < turns; t++) h.model.push(toolTurn(4_000 + ((seed + t) % 3) * 1_000, seed * 100 + t));
		h.model.push(finalTurn(`done ${seed}`));
		await h.harness.session.prompt(prompt);
	}

	const lastHeader = (h: Awaited<ReturnType<typeof setup>>) => {
		for (let i = h.model.requests.length - 1; i >= 0; i--) {
			const header = headerOf(h.model.requests[i]);
			if (header) return header;
		}
		return "";
	};

	it("rules survive 3+ cuts with the pin; without it (pin off: the pinned task and latest instruction only) they are gone", async () => {
		const results: Record<string, { cuts: number; header: string; visible: boolean }> = {};
		for (const mode of ["on", "off"] as const) {
			const h = await setup(mode === "on" ? PIN : null);
			h.model.push(finalTurn("Understood."));
			await h.harness.session.prompt(RULES);
			// Like E4's filler prompts: each is a new run prompt (H5 task).
			for (let p = 0; p < 8; p++)
				await work(h, `Look at report part ${p} and summarize the three main findings in it.`, 5, p + 1);
			const last = h.model.requests[h.model.requests.length - 1];
			results[mode] = {
				cuts: h.stats.cuts.length,
				header: lastHeader(h),
				visible: last.some((m) => m.includes("src/zz-legacy-q7/")),
			};
		}
		expect(results.on.cuts).toBeGreaterThanOrEqual(3);
		expect(results.off.cuts).toBeGreaterThanOrEqual(3);
		// On: the rules are in the header's pin, verbatim; the pin replaces the H5 task.
		expect(pinBlock(results.on.header)).toContain(RULES);
		expect(results.on.header).not.toContain("<pinned-task>");
		expect(results.on.visible).toBe(true);
		// Off: the r5 header (pinned task, no pin) and the rules are nowhere in the request.
		expect(results.off.header).toContain("<pinned-task>");
		expect(results.off.header).not.toContain("<pinned-user-messages>");
		expect(results.off.visible).toBe(false);
	});

	it("cap holds: the first 3 stay verbatim, the middle goes first, oldest first (the newest middle message stays longest)", async () => {
		const h = await setup(PIN);
		const prompts = Array.from({ length: 40 }, (_, i) =>
			`Prompt ${String(i).padStart(2, "0")} marker-${i}-x: ${syntheticText(1_200, 900 + i).replace(/\s+/g, " ")}`.trim(),
		);
		for (let i = 0; i < prompts.length; i++) await work(h, prompts[i], 2, 50 + i);
		const block = pinBlock(lastHeader(h));
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(3);
		expect(block).not.toBe("");
		expect(textTokens(block)).toBeLessThanOrEqual(Math.floor(PIN.capFraction * MODEL.contextWindow));
		for (let i = 0; i < 3; i++) expect(block).toContain(prompts[i]);
		// P3: the middle is shortened oldest first (pointer, then range), so along the carried middle the form
		// never gets poorer from older to newer: range <= pointer <= verbatim. (A pointer starts with the
		// prompt's first 200 characters, so its marker is in the block; a range names neither.)
		const carriedCount = prompts.findLastIndex((p, i) => block.includes(p) || block.includes(`marker-${i}-x`)) + 1;
		expect(carriedCount).toBeGreaterThan(3);
		const rank = prompts
			.slice(3, carriedCount)
			.map((p, k) => (block.includes(p) ? 2 : block.includes(`marker-${k + 3}-x`) ? 1 : 0));
		expect([...rank].sort((x, y) => x - y)).toEqual(rank);
		// The middle was shortened: some carried prompts are pointers or a range line, not verbatim.
		expect(rank.some((r) => r < 2)).toBe(true);
		expect(block).toMatch(
			/\[\d+ user message\(s\) .* not shown; context_search finds them\]|\[user message \S+ \([^)]*\), \d+ chars/,
		);
		// Oldest first.
		const order = prompts.map((p) => block.indexOf(p)).filter((x) => x >= 0);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("a long paste is carried as a pointer for context_recall, not verbatim", async () => {
		const h = await setup(PIN);
		h.model.push(finalTurn("Understood."));
		await h.harness.session.prompt(RULES);
		const paste = `Here is the log I mentioned:\n${"ERR-PASTE-BODY-77 db timeout at shard 4\n".repeat(160)}`;
		h.model.push(finalTurn("Noted."));
		await h.harness.session.prompt(paste);
		for (let p = 0; p < 8; p++) await work(h, `Check part ${p}.`, 5, 200 + p);
		const block = pinBlock(lastHeader(h));
		expect(block).toContain(RULES);
		expect(block).not.toContain("ERR-PASTE-BODY-77 db timeout at shard 4\nERR-PASTE-BODY-77");
		// P3: the pointer carries the first 200 characters, whitespace collapsed (not just the first line).
		const preview = paste.trim().slice(0, 200).replace(/\s+/g, " ").trim();
		// D5 (port): the length is that of the text context_recall reads (its "of N"), not the trimmed text.
		expect(block).toContain(`, ${paste.length} chars, starts "${preview}…"; context_recall reads it]`);
	});

	it("a later user message that revokes an earlier rule is carried after it, in order (the model sees both)", async () => {
		const h = await setup(PIN);
		h.model.push(finalTurn("Understood."));
		await h.harness.session.prompt(RULES);
		for (let p = 0; p < 3; p++) await work(h, `Warm-up ${p}.`, 1, 300 + p);
		const revoke = "Change of plan: the fmtly ban is lifted. You may use the `fmtly` library again from now on.";
		h.model.push(finalTurn("Noted, fmtly is allowed again."));
		await h.harness.session.prompt(revoke);
		for (let p = 0; p < 8; p++) await work(h, `Continue with part ${p}.`, 5, 310 + p);
		const block = pinBlock(lastHeader(h));
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(3);
		expect(block).toContain(RULES);
		expect(block).toContain(revoke);
		expect(block.indexOf(revoke)).toBeGreaterThan(block.indexOf(RULES));
		expect(block).toContain(
			"Your user's earlier messages, oldest first, with the day each was sent (UTC). Their instructions and constraints still apply unless a later message changes them. A message marked already handled was a request that was done before this window: do not do its task again unless the current request asks you to.",
		);
	});

	it("includes the H5 task: the run's prompt, once out of the window, is carried as the current request; a context_notes task stays pinned", async () => {
		const h = await setup(PIN);
		const task = "Refactor the billing module into three files and keep every public function name unchanged.";
		h.model.push(() =>
			fauxAssistantMessage(
				[
					fauxToolCall(
						"context_notes",
						{ notes: "Plan: split billing.", task: "NOTE-TASK-XYZ keep names" },
						{ id: "notes-1" },
					),
				],
				{
					stopReason: "toolUse",
				},
			),
		);
		for (let t = 0; t < 30; t++) h.model.push(toolTurn(4_000 + (t % 3) * 1_000, 700 + t));
		h.model.push(finalTurn("done"));
		await h.harness.session.prompt(task);
		const header = lastHeader(h);
		const block = pinBlock(header);
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(1);
		const entries = block.split("\n--- user message ").slice(1);
		expect(entries[entries.length - 1]).toContain(`current request) ---\n${task}`);
		expect(header).toContain("<pinned-task>\nNOTE-TASK-XYZ keep names\n</pinned-task>");
		expect(header.split(task).length - 1).toBe(1); // carried once, not also as a pinned task
	});

	it("the cap scales with the window ceiling: 10% of 100k on a 1M model (E4 arm D'), 10% of 200k as control", async () => {
		const LONG = { id: "faux-1m", contextWindow: 1_048_576, maxTokens: 16_384 };
		const sizes: Record<string, { tokens: number; cuts: number; shortened: boolean }> = {};
		for (const ceiling of [100_000, 200_000]) {
			const h = await setup(PIN, LONG, ceiling);
			// About 18k tokens of user text: more than 10% of 100k, less than 10% of 200k.
			for (let i = 0; i < 60; i++) {
				const prompt = `Request ${i} id-${i}-q: ${syntheticText(1_200, 2_000 + i).replace(/\s+/g, " ")}`.trim();
				for (let t = 0; t < 2; t++) h.model.push(toolTurn(12_000, 3_000 + i * 10 + t));
				h.model.push(finalTurn(`done ${i}`));
				await h.harness.session.prompt(prompt);
			}
			const block = pinBlock(h.seen.header);
			sizes[ceiling] = {
				// D9 (port): the cap is in provider tokens, the estimate at the model's calibration ratio.
				tokens: textTokens(block) * (h.stats.sent.at(-1)?.ratio ?? 1),
				cuts: h.stats.cuts.length,
				shortened: /\[user message \S+ \([^)]*\), \d+ chars|user message\(s\) .* not shown/.test(block),
			};
		}
		expect(sizes[100_000].cuts).toBeGreaterThanOrEqual(1);
		expect(sizes[200_000].cuts).toBeGreaterThanOrEqual(1);
		// 100k ceiling: the block is held to 10k (not 10% of the model's 1M window) and had to be shortened.
		expect(sizes[100_000].tokens).toBeLessThanOrEqual(10_000);
		expect(sizes[100_000].tokens).toBeGreaterThan(5_000);
		expect(sizes[100_000].shortened).toBe(true);
		// 200k ceiling: the same session's block may grow past 10k, up to 20k.
		expect(sizes[200_000].tokens).toBeGreaterThan(10_000);
		expect(sizes[200_000].tokens).toBeLessThanOrEqual(20_000);
	});

	it("P2b: the header is planned at the cut: never below the header rendered there, on a session with many user messages", async () => {
		const h = await setup(PIN);
		// 70 user messages of mixed size (short, about 1.2k characters, pastes over 2k), 2 tool turns each.
		for (let i = 0; i < 70; i++) {
			const size = i % 7 === 3 ? 3_000 : i % 2 === 0 ? 1_200 : 80;
			const prompt = `Message ${i} tag-${i}-m: ${syntheticText(size, 4_000 + i).replace(/\s+/g, " ")}`.trim();
			await work(h, prompt, 2, 400 + i);
		}
		const plans = h.stats.headerPlans;
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(3);
		expect(plans.length).toBeGreaterThanOrEqual(h.stats.cuts.length);
		expect(h.stats.headerBoundMisses).toBe(0);
		for (const p of plans) {
			// Planned with exactly the header rendered at the chosen cut, and the bound was never below it.
			expect(p.planned).toBe(p.rendered);
			expect(p.upper).toBeGreaterThanOrEqual(p.rendered);
		}
		// The bound is conservative: measuring at the cut gave room back at least once.
		expect(plans.some((p) => p.rendered < p.upper)).toBe(true);
	});

	it("with the pin off the planner records no header plans", async () => {
		const h = await setup(null);
		for (let i = 0; i < 20; i++)
			await work(h, `Please look at section ${i} of the quarterly report and list its findings.`, 3, 500 + i);
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(2);
		expect(h.stats.headerPlans).toHaveLength(0);
	});

	it("P2b: images in user messages are carried as markers; an image-only message as an image line", async () => {
		const h = await setup(PIN);
		// Real 1x1 images (Pi replaces undecodable image data with an "[Image omitted ...]" text block).
		const png = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
		};
		const jpeg = { ...png };
		h.model.push(finalTurn("Understood."));
		await h.harness.session.prompt("Make the login page look like this screenshot, keep the colours exactly.", {
			images: [png],
		});
		h.model.push(finalTurn("Got it."));
		await h.harness.session.prompt("", { images: [jpeg] });
		for (let p = 0; p < 8; p++)
			await work(h, `Implement step ${p} of the redesign and run the tests afterwards.`, 5, 600 + p);
		const block = pinBlock(lastHeader(h));
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(1);
		expect(block).toContain("--- user message");
		expect(block).toContain(
			"Make the login page look like this screenshot, keep the colours exactly.\n[image: image/png]",
		);
		expect(block).toMatch(
			/\[user message \S+ \([^)]*\): an image \(image\/png\) and no text; context_recall reads it\]/,
		);
	});
});
