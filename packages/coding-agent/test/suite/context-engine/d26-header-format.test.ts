/**
 * D26 rollout (R2): the header is recorded in the cut entry and replayed until the next cut, so a session resumed
 * after a header format change would send its old header for the rest of that window. Each cut entry records the
 * format (`hv`); the first aligned request of a session whose latest cut has an older or no format forces a cut,
 * through the ordinary cut path, logged with its reason. Sections (D19) and a pending refresh (E8.14) behave as at
 * any cut.
 */

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../../../../../.pi/extensions/penpi/engine/index.ts";
import { HEADER_FORMAT, STATE_TYPE } from "../../../../../.pi/extensions/penpi/engine/options.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const host = { memo: "A" };

type CutData = { kind: "cut"; seq: number; hv?: number; header: string; sections?: unknown; sectionsUnchanged?: true };

async function session(sessionManager: SessionManager) {
	let handle: EngineHandle | undefined;
	const stats = newStats();
	const lines: string[] = [];
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		sessionManager,
		extensionFactories: [
			workExtension,
			(pi: ExtensionAPI) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.memo = host.memo;
				});
			},
			createContextEngine(
				{ stats, log: (line) => lines.push(line) },
				{
					onInstall: (installed: EngineHandle) => {
						handle = installed;
					},
				},
			),
		],
	});
	await harness.session.bindExtensions({});
	if (!handle) throw new Error("engine not installed");
	const model = scriptedModel(harness, 400);
	// Per request: the memo section sent, the header sent, and the engine's cut count when it was sent.
	const sent: Array<{ memo: string; header: string; cuts: number }> = [];
	const inner = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (m, context, options) => {
		const merged = getCurrentSystemMessage(context.messages as Message[]);
		let header = "";
		for (const msg of context.messages) {
			const c = msg.content as unknown;
			const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("\n") : "";
			if (text.includes("[context window #")) header = text;
		}
		sent.push({ memo: merged?.sections?.memo ?? "", header, cuts: stats.cuts.length });
		return inner(m, context, options);
	};
	const cutEntries = () =>
		harness.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === STATE_TYPE && (e.data as CutData).kind === "cut")
			.map((e) => (e as { data: CutData }).data);
	return { harness, stats, lines, model, sent, cutEntries, handle: handle as EngineHandle };
}

/** A session file with `cuts` cut(s) or none: a short question, then (when cuts > 0) a long batch of tool turns. */
async function recorded(withCut: boolean, setSection?: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "ce-hv-"));
	const s = await session(SessionManager.create(dir, dir));
	s.model.push(finalTurn("one"));
	await s.harness.session.prompt("task 1: a short question.");
	if (setSection) s.handle.setSectionAtNextCut("memo", setSection);
	if (withCut) {
		for (let t = 0; t < 20; t++) s.model.push(toolTurn(6_000, t));
		s.model.push(finalTurn("two"));
		await s.harness.session.prompt("task 2: process the batch.");
		expect(s.stats.cuts.length).toBeGreaterThan(0);
	}
	const file = s.harness.sessionManager.getSessionFile()!;
	s.harness.cleanup();
	return file;
}

/** A copy of a session file whose cut entries look like RC4's: no `hv`. */
function asOldFormat(file: string, suffix = "old"): string {
	const copy = `${file}.${suffix}.jsonl`;
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			const e = JSON.parse(l) as { type?: string; customType?: string; data?: { kind?: string; hv?: number } };
			if (e.type === "custom" && e.customType === STATE_TYPE && e.data?.kind === "cut") delete e.data.hv;
			return JSON.stringify(e);
		});
	writeFileSync(copy, `${lines.join("\n")}\n`);
	return copy;
}

function copyOf(file: string, suffix: string): string {
	const copy = `${file}.${suffix}.jsonl`;
	copyFileSync(file, copy);
	return copy;
}

describe("D26 rollout: a header format change reaches resumed sessions with one cut", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		host.memo = "A";
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d26 every new cut entry records the header format", async () => {
		const file = await recorded(true);
		const cuts = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.includes('"kind":"cut"'))
			.map((l) => (JSON.parse(l) as { data: CutData }).data);
		expect(cuts.length).toBeGreaterThan(0);
		for (const c of cuts) expect(c.hv).toBe(HEADER_FORMAT);
	});

	it("d26 an old-format session cuts once, at its first request, logged with the reason; the header is in the current format", async () => {
		const old = asOldFormat(await recorded(true));
		const s = await session(SessionManager.open(old));
		harnesses.push(s.harness);
		const before = s.cutEntries();
		expect(before.at(-1)?.hv).toBeUndefined();
		s.model.push(finalTurn("three"));
		await s.harness.session.prompt("task 3: a short question.");
		s.model.push(finalTurn("four"));
		await s.harness.session.prompt("task 4: another short question.");
		// One cut, made at the first request, with the reason in its log line.
		expect(s.stats.cuts.length).toBe(1);
		// (sent records the count when the request leaves the planner: the first request already includes its cut.)
		expect(s.sent[0].cuts).toBe(1);
		expect(s.sent.at(-1)?.cuts).toBe(1);
		expect(s.lines.some((l) => new RegExp(`cut #\\d+ \\(header format 1 -> ${HEADER_FORMAT}\\)`).test(l))).toBe(true);
		const after = s.cutEntries();
		expect(after.length).toBe(before.length + 1);
		expect(after.at(-1)).toMatchObject({ hv: HEADER_FORMAT, seq: (before.at(-1)?.seq ?? 0) + 1 });
		// The first request already carries the new header (the D26 current-request line, dated markers).
		expect(s.sent[0].header).toContain(`[context window #${after.at(-1)?.seq}]`);
		expect(s.sent[0].header).toContain("Current request: user message ");
		expect(s.sent.at(-1)?.header).toBe(s.sent[0].header);
	});

	it("d26 a current-format session does not cut for the format; a session with no cut entry is untouched", async () => {
		for (const withCut of [true, false]) {
			const s = await session(SessionManager.open(copyOf(await recorded(withCut), "same")));
			harnesses.push(s.harness);
			const before = s.cutEntries().length;
			expect(before > 0).toBe(withCut);
			s.model.push(finalTurn("three"));
			await s.harness.session.prompt("task 3: a short question.");
			expect(s.stats.cuts.length, `withCut ${withCut}`).toBe(0);
			expect(s.cutEntries().length).toBe(before);
			expect(s.lines.some((l) => l.includes("header format"))).toBe(false);
		}
	});

	it("d26 sections (D19) and a pending refresh behave as at any cut", async () => {
		// A session whose cut applied memo "C" (recorded in the cut entry), in both formats.
		const file = await recorded(true, "C");
		const results: Record<string, { entry: CutData; memoAfter: string }> = {};
		for (const [name, path, pending] of [
			["forced, nothing pending", asOldFormat(file), undefined],
			["ordinary, nothing pending", copyOf(file, "ord"), undefined],
			["forced, refresh pending", asOldFormat(file, "old2"), "D"],
			["ordinary, refresh pending", copyOf(file, "ord2"), "D"],
		] as const) {
			const s = await session(SessionManager.open(path));
			harnesses.push(s.harness);
			if (pending) s.handle.setSectionAtNextCut("memo", pending);
			if (name.startsWith("forced")) {
				s.model.push(finalTurn("three"));
				await s.harness.session.prompt("task 3: a short question.");
			} else {
				// An ordinary cut: enough work to cross the high-water mark.
				for (let t = 0; t < 20; t++) s.model.push(toolTurn(6_000, 300 + t));
				s.model.push(finalTurn("three"));
				await s.harness.session.prompt("task 3: process the next batch.");
			}
			expect(s.stats.cuts.length, name).toBeGreaterThan(0);
			// The first cut of the resumed session, and the memo sent right after it.
			const entry = s.cutEntries().at(-s.stats.cuts.length)!;
			const firstCutRequest = s.sent.findIndex((r) => r.cuts > 0);
			results[name] = { entry, memoAfter: s.sent[firstCutRequest]?.memo ?? "" };
		}
		const pick = (r: { entry: CutData; memoAfter: string }) => ({
			sections: r.entry.sections,
			sectionsUnchanged: r.entry.sectionsUnchanged,
			memoAfter: r.memoAfter,
		});
		// The forced cut records the sections exactly as an ordinary cut does, and sends the same memo after it.
		expect(pick(results["forced, nothing pending"])).toEqual(pick(results["ordinary, nothing pending"]));
		expect(pick(results["forced, refresh pending"])).toEqual(pick(results["ordinary, refresh pending"]));
		// Not vacuous. A resume starts from the host's own text (Pi records memo A again, newer than the cut's C), so
		// with nothing pending neither cut records sections (D19) and both send A; a pending D is recorded and sent.
		expect(results["forced, nothing pending"].entry.sections).toBeUndefined();
		expect(results["forced, nothing pending"].entry.sectionsUnchanged).toBeUndefined();
		expect(results["forced, nothing pending"].memoAfter).toBe("<memo>\nA\n</memo>");
		expect(results["forced, refresh pending"].entry.sections).toEqual({ memo: "<memo>\nD\n</memo>" });
		expect(results["forced, refresh pending"].memoAfter).toContain("D");
		expect(results["forced, nothing pending"].entry.hv).toBe(HEADER_FORMAT);
	});

	it("d26 after the forced cut, a /compact rebuild and a second resume do not cut for the format again", async () => {
		const old = asOldFormat(await recorded(true), "twice");
		const formatLines = (lines: string[]) => lines.filter((l) => l.includes("header format")).length;
		const first = await session(SessionManager.open(old));
		harnesses.push(first.harness);
		first.model.push(finalTurn("three"));
		await first.harness.session.prompt("task 3: a short question.");
		expect(first.stats.cuts.length).toBe(1);
		expect(formatLines(first.lines)).toBe(1);
		// A rebuild (/compact): a manual cut, recorded in the current format; the next request does not cut for the format.
		const rebuildsBefore = first.stats.indexRebuilds;
		const entriesBefore = first.cutEntries().length;
		await first.harness.session.compact().catch(() => undefined);
		first.model.push(finalTurn("four"));
		await first.harness.session.prompt("task 4: a short question.");
		expect(first.stats.indexRebuilds).toBeGreaterThan(rebuildsBefore);
		expect(first.cutEntries().length).toBe(entriesBefore + 1);
		expect(first.cutEntries().at(-1)?.hv).toBe(HEADER_FORMAT);
		expect(formatLines(first.lines)).toBe(1);
		const entries = first.cutEntries().length;
		first.harness.cleanup();
		// A second resume of the same file: no cut, no new cut entry, no format line.
		const second = await session(SessionManager.open(old));
		harnesses.push(second.harness);
		for (const n of ["five", "six"]) {
			second.model.push(finalTurn(n));
			await second.harness.session.prompt(`task ${n}: a short question.`);
		}
		expect(second.stats.cuts.length).toBe(0);
		expect(second.cutEntries().length).toBe(entries);
		expect(formatLines(second.lines)).toBe(0);
	});

	it("d26 a session whose only cut-like entry is Pi's native compaction is untouched", async () => {
		const file = copyOf(await recorded(false), "native");
		// Pi's own compaction entry (no engine details), as a 0.4 session with compaction enabled could hold.
		const sm = SessionManager.open(file);
		const kept = sm
			.getBranch()
			.filter((e) => e.type === "message" && e.message.role === "user")
			.at(-1)!;
		sm.appendCompaction("Summary of the earlier conversation.", kept.id, 1_000);
		const s = await session(SessionManager.open(file));
		harnesses.push(s.harness);
		expect(s.harness.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(true);
		expect(s.cutEntries().length).toBe(0);
		s.model.push(finalTurn("three"));
		await s.harness.session.prompt("task 3: a short question.");
		expect(s.stats.cuts.length).toBe(0);
		expect(s.cutEntries().length).toBe(0);
		expect(s.lines.some((l) => l.includes("header format"))).toBe(false);
		expect(s.lines.filter((l) => l.includes(" error"))).toEqual([]);
	});
});
