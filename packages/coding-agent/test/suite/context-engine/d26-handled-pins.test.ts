/**
 * D26 (Chief on RC4, 2026-10-24, /home/frank/briefs/d26-stale-pins.md): after a cut, a weak model read the pinned
 * user messages as a queue of open work and redid old requests (a finished article edited again, an old cleanup, an
 * old discovery run). The pin now says it at every message:
 *   C1 every carried message that is not the current request is labelled already handled (its rules still apply,
 *      its task is not done again unless the current request asks), in the verbatim, pointer and range forms;
 *   C2 the header names the current request in a line of its own, pinned (marked there) or still in the window
 *      (its id and first words); no current request, no line;
 *   C3 every marker carries the UTC day the message was sent;
 *   C4 the line ends: when the current request is done, stop and report; do not start requests from earlier
 *      messages;
 *   C5 the header still changes only at a cut, and the cap and the header bound hold with the longer markers.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, type EngineOptions, newStats, textTokens } from "./engine.ts";
import { finalTurn, report, scriptedModel, syntheticText, toolTurn, workExtension } from "./helpers.ts";

const MODEL = { id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 };
const HANDLED =
	"earlier request, already handled: its rules still apply; do not do its task again unless the current request asks you to";
const HANDLED_RANGE =
	"already handled: their rules still apply; do not do their tasks again unless the current request asks you to";
const INTRO_CLAUSE =
	"A message marked already handled was a request that was done before this window: do not do its task again unless the current request asks you to.";
const DONE = "When the current request is done, stop and report; do not start requests from earlier messages.";
const RULES = "Ground rules for this repo: all new files go under `src/zz-legacy-q7/`; never use the `fmtly` library.";
const PNG = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
};
const DAY = /^\d{4}-\d\d-\d\d$/;

function pinBlock(header: string): string {
	const a = header.indexOf("<pinned-user-messages>");
	const b = header.indexOf("</pinned-user-messages>");
	return a < 0 || b < 0 ? "" : header.slice(a, b + "</pinned-user-messages>".length);
}

/** The header's current-request line, or undefined. */
function currentLine(header: string): string | undefined {
	return header.split("\n").find((l) => l.startsWith("Current request: "));
}

/** Every message marker of a pin block: verbatim, pointer and range lines, with their parenthesis. */
function markers(block: string): Array<{ kind: "verbatim" | "pointer" | "range"; id: string; tag: string }> {
	const out: Array<{ kind: "verbatim" | "pointer" | "range"; id: string; tag: string }> = [];
	for (const line of block.split("\n")) {
		let m = /^--- user message (\S+) \(([^)]*)\) ---$/.exec(line);
		if (m) out.push({ kind: "verbatim", id: m[1], tag: m[2] });
		m = /^\[user message (\S+) \(([^)]*)\)[,:]/.exec(line);
		if (m) out.push({ kind: "pointer", id: m[1], tag: m[2] });
		m = /^\[\d+ earlier user message\(s\) (\S+)…\S+ \(([^)]*)\) not shown/.exec(line);
		if (m) out.push({ kind: "range", id: m[1], tag: m[2] });
	}
	return out;
}

describe("D26: pinned requests are marked already handled; the current request is named", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(engine: Partial<EngineOptions> | null = {}, options: { sessionManager?: SessionManager } = {}) {
		const stats = newStats();
		const factories: ExtensionFactory[] = [workExtension];
		if (engine) factories.push(createContextEngine({ stats, ...engine }));
		const sessionManager = options.sessionManager;
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false } },
			...(sessionManager
				? {
						sessionManager,
						resourceLoader: createTestResourceLoader({
							extensionsResult: await createTestExtensionsResult(factories, sessionManager.getCwd()),
						}),
					}
				: { extensionFactories: factories }),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions(sessionManager ? { uiContext: createTestUiContext() } : {});
		// Every request's header, with the user messages in its window (by text).
		const seen: Array<{ header: string; window: string[] }> = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, opts) => {
			let header = "";
			const window: string[] = [];
			for (const msg of context.messages) {
				if (msg.role === "system") continue;
				const c = msg.content as string | Array<{ type: string; text?: string }>;
				const text = typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n");
				if (text.includes("[context window #")) header = text;
				else if (msg.role === "user") window.push(text);
			}
			seen.push({ header, window });
			return inner(m, context, opts);
		};
		return { stats, harness, seen, model: scriptedModel(harness, 4_000, { digest: true }) };
	}

	type H = Awaited<ReturnType<typeof setup>>;
	async function work(h: H, prompt: string, turns: number, seed: number) {
		for (let t = 0; t < turns; t++) h.model.push(toolTurn(4_000 + ((seed + t) % 3) * 1_000, seed * 100 + t));
		h.model.push(finalTurn(`done ${seed}`));
		await h.harness.session.prompt(prompt);
	}
	async function said(h: H, text: string) {
		h.model.push(finalTurn("Understood."));
		await h.harness.session.prompt(text);
	}
	/** The user message entries of the session, by text. */
	function userIds(h: H): Map<string, string> {
		const ids = new Map<string, string>();
		for (const e of h.harness.sessionManager.getEntries()) {
			if (e.type !== "message" || e.message.role !== "user") continue;
			const c = e.message.content as string | Array<{ type: string; text?: string }>;
			ids.set(typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n"), e.id);
		}
		return ids;
	}

	it("d26 the current request still in the window is named (id, in your context below, first words), not carried; the earlier ones are handled", async () => {
		const h = await setup();
		await said(h, RULES);
		const prompts = Array.from({ length: 4 }, (_, p) => `Task ${p}: migrate module ${p} and report what changed.`);
		for (let p = 0; p < prompts.length; p++) await work(h, prompts[p], 12, 10 + p);
		const ids = userIds(h);
		const inWindow = h.seen.filter((s) => s.header && currentLine(s.header)?.includes("in your context below"));
		expect(h.stats.cuts.length).toBeGreaterThanOrEqual(2);
		expect(inWindow.length).toBeGreaterThan(0);
		for (const s of inWindow) {
			const line = currentLine(s.header)!;
			const id = /^Current request: user message (\S+) /.exec(line)?.[1];
			const prompt = prompts.find((p) => ids.get(p) === id);
			expect(prompt, line).toBeDefined();
			// Named: id, where it is, its first words (as a pointer); then C4, last.
			expect(line).toMatch(
				/^Current request: user message \S+ \(sent \d{4}-\d\d-\d\d\), in your context below; it starts "/,
			);
			expect(line).toContain(`it starts "${prompt}"`);
			expect(line.endsWith(DONE)).toBe(true);
			// Not carried by the pin, and every carried message is handled.
			const block = pinBlock(s.header);
			expect(block).not.toContain(`user message ${id} `);
			for (const m of markers(block)) expect(m.tag, m.id).toContain(HANDLED);
		}
		report("d26", "revised", "current-in-window", { cuts: h.stats.cuts.length, headers: inWindow.length });
	});

	it("d26 the current request pinned: marked current request (not handled) and named by the line as marked above", async () => {
		const h = await setup();
		await said(h, RULES);
		const task = "Rebuild the search index for every project and report the counts.";
		await work(h, task, 30, 40);
		const ids = userIds(h);
		const pinned = h.seen.filter((s) => s.header && pinBlock(s.header).includes(`user message ${ids.get(task)} `));
		expect(pinned.length).toBeGreaterThan(0);
		for (const s of pinned) {
			const block = pinBlock(s.header);
			const own = markers(block).find((m) => m.id === ids.get(task))!;
			expect(own.tag).toMatch(/^sent \d{4}-\d\d-\d\d; current request$/);
			expect(own.tag).not.toContain("already handled");
			const rules = markers(block).find((m) => m.id === ids.get(RULES))!;
			expect(rules.tag).toContain(HANDLED);
			expect(currentLine(s.header)).toBe(
				`Current request: user message ${ids.get(task)} (${own.tag.split(";")[0]}), marked current request in the pinned messages above. It was the latest request when this window started and may still be in progress; a newer user message after this point supersedes it. ${DONE}`,
			);
		}
	});

	it("d26 no current request (a resumed session without run records, continued): no current-request line, every carried message handled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ce-d26-"));
		// Without the engine: user messages, no run records; the session ends on a user message.
		const first = await setup(null, { sessionManager: SessionManager.create(dir, dir) });
		await said(first, RULES);
		for (let p = 0; p < 3; p++) await work(first, `Old task ${p}: tidy folder ${p}.`, 3, 60 + p);
		first.harness.sessionManager.appendMessage({
			role: "user",
			content: "Old task 3: tidy folder 3.",
			timestamp: Date.now(),
		});
		const file = first.harness.sessionManager.getSessionFile()!;
		// With the engine: continued without a prompt, so no run starts; tool turns until cuts.
		const second = await setup({}, { sessionManager: SessionManager.open(file) });
		for (let t = 0; t < 30; t++) second.model.push(toolTurn(4_000 + (t % 3) * 1_000, 700 + t));
		second.model.push(finalTurn("done"));
		// The resumed messages, as a prompt would load them (Pi's projection of the session).
		second.harness.session.agent.state.messages = second.harness.sessionManager.buildSessionProjection().messages;
		await second.harness.session.agent.continue();
		expect(second.stats.cuts.length).toBeGreaterThan(0);
		const header = second.seen.at(-1)!.header;
		expect(header).toContain("[context window #");
		expect(currentLine(header)).toBeUndefined();
		expect(header).not.toContain(DONE);
		const ms = markers(pinBlock(header));
		expect(ms.length).toBeGreaterThan(0);
		for (const m of ms) expect(m.tag).toContain(HANDLED);
		expect(pinBlock(header)).toContain(INTRO_CLAUSE);
	});

	it("d26 pointer, range and image forms keep the handled label and the date; the cap and the header bound hold", async () => {
		const h = await setup({ pinUserMessages: { capFraction: 0.02, protectFirst: 1 } });
		// The image-only message first: protected, it is the last of the earlier messages to become a pointer.
		h.model.push(finalTurn("Noted."));
		await h.harness.session.prompt("", { images: [PNG] });
		await said(h, RULES);
		for (let p = 0; p < 14; p++)
			await work(h, `Part ${p}: ${syntheticText(900, 300 + p).replace(/\s+/g, " ")}`.trim(), 3, 70 + p);
		const header = h.seen.at(-1)!.header;
		const block = pinBlock(header);
		const ms = markers(block);
		const kinds = new Set(ms.map((m) => m.kind));
		expect(kinds.has("pointer")).toBe(true);
		expect(kinds.has("range")).toBe(true);
		expect(block).toMatch(/\[user message \S+ \([^)]*\): an image \(image\/png\) and no text/);
		for (const m of ms) {
			const [sent] = m.tag.split("; ");
			expect(sent, m.tag).toMatch(/^sent \d{4}-\d\d-\d\d( to \d{4}-\d\d-\d\d)?$/);
			if (m.kind === "range") expect(m.tag).toContain(HANDLED_RANGE);
			else if (!m.tag.includes("current request")) expect(m.tag).toContain(HANDLED);
		}
		// C5: the cap holds with the longer markers (calibrated, D9), and the bound used before the cut never
		// fell below the rendered header.
		const ratio = h.stats.sent.at(-1)?.ratio ?? 1;
		expect(textTokens(block) * ratio).toBeLessThanOrEqual(Math.floor(0.02 * MODEL.contextWindow));
		expect(h.stats.headerBoundMisses).toBe(0);
		for (const plan of h.stats.headerPlans) expect(plan.upper).toBeGreaterThanOrEqual(plan.rendered);
	});

	it("d26 dates: each marker carries the UTC day its message was sent", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-16T23:30:00Z"));
		const h = await setup();
		await said(h, "Fresh discovery run for today, October 16 2026.");
		vi.setSystemTime(new Date("2026-10-17T08:00:00Z"));
		await said(h, RULES);
		vi.setSystemTime(new Date("2026-10-24T11:49:00Z"));
		await work(h, "[manager] New task: a trial run on one archive topic.", 30, 90);
		const ids = userIds(h);
		const header = h.seen.at(-1)!.header;
		const tags = new Map(markers(pinBlock(header)).map((m) => [m.id, m.tag]));
		expect(tags.get(ids.get("Fresh discovery run for today, October 16 2026.")!)).toMatch(/^sent 2026-10-16; /);
		expect(tags.get(ids.get(RULES)!)).toMatch(/^sent 2026-10-17; /);
		const current = ids.get("[manager] New task: a trial run on one archive topic.")!;
		const line = currentLine(header)!;
		expect(line).toContain(`user message ${current} (sent 2026-10-24`);
		for (const tag of tags.values()) expect(tag.split("; ")[0].slice(5).split(" to ")[0]).toMatch(DAY);
	});

	it("d26 an interrupted task, then 'Keep going' as the current request: the task is handled unless the current request asks, and the line names Keep going", async () => {
		const h = await setup();
		await said(h, RULES);
		const task = "Write the release notes for 0.5.0 from the changelog, section by section.";
		await work(h, task, 6, 120);
		await work(h, "[manager] Keep going.", 30, 130);
		const ids = userIds(h);
		const header = h.seen.at(-1)!.header;
		const block = pinBlock(header);
		expect(block).toContain(INTRO_CLAUSE);
		const tag = markers(block).find((m) => m.id === ids.get(task))?.tag;
		expect(tag).toContain("do not do its task again unless the current request asks you to");
		const line = currentLine(header)!;
		expect(line).toContain(`user message ${ids.get("[manager] Keep going.")} `);
		expect(line).toMatch(/marked current request in the pinned messages above|it starts "\[manager\] Keep going\."/);
		expect(line.endsWith(DONE)).toBe(true);
	});

	it("d26 byte stability: within a window every request carries the identical header", async () => {
		const h = await setup();
		await said(h, RULES);
		for (let p = 0; p < 3; p++) await work(h, `Task ${p}: check module ${p}.`, 12, 150 + p);
		const bySeq = new Map<string, Set<string>>();
		for (const s of h.seen) {
			const seq = /\[context window #(\d+)\]/.exec(s.header)?.[1];
			if (!seq) continue;
			if (!bySeq.has(seq)) bySeq.set(seq, new Set());
			bySeq.get(seq)!.add(s.header);
		}
		expect(bySeq.size).toBeGreaterThanOrEqual(2);
		for (const [seq, headers] of bySeq) expect(headers.size, `window #${seq}`).toBe(1);
	});
});
