/**
 * E8.14: a host changes a system prompt section only at a cut (EngineHandle.setSectionAtNextCut), so the system
 * prompt, and the provider's prompt cache, change only where the window does. Against a real session:
 *   - the change arrives with the first cut request, not before;
 *   - a copy of the section older than the change, still in the kept window, does not undo it;
 *   - a rebuilt window (manual /compact) sends the same prompt, from the cut entry;
 *   - a resumed session starts from the host's own text, which Pi records again (newer than the change).
 */

import { getCurrentSystemMessage, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineHandle } from "../../../../../.pi/extensions/penpi/engine/index.ts";
import { systemPromptSection } from "../../../../../.pi/extensions/penpi/engine/options.ts";
import { buildSystemPromptSections } from "../../../src/core/system-prompt.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats, textTokens } from "./engine.ts";
import { finalTurn, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

/** What the host sets in before_agent_start (Pi records a change as a system message). */
/** The host's sections: memo, and (N6, round 4) another section when set. */
const host: { memo: string; other?: string } = { memo: "" };
/**
 * Later 5: while set, another extension adds a message to every request, which the engine cannot align. With
 * dropSystem it also removes the request's system messages (N0, round 4: a transcript without one before the cut).
 */
const injector = { on: false, dropSystem: false };

async function session(sessionManager?: SessionManager, contextWindow = 32_000, sameCwd = false) {
	let handle: EngineHandle | undefined;
	const stats = newStats();
	const lines: string[] = [];
	// sameCwd: the harness names its directory from the clock and Math.random; fixed, a resumed session gets the
	// same directory (cwd is in the system prompt), so Pi records no new system prompt at the resume.
	const clock = sameCwd ? vi.spyOn(Date, "now").mockReturnValue(1_792_000_000_000) : undefined;
	const random = sameCwd ? vi.spyOn(Math, "random").mockReturnValue(0.25) : undefined;
	const created = createHarness({
		models: [{ id: `faux-${contextWindow / 1000}k`, contextWindow, maxTokens: 4_000 }],
		// keepRecentTokens: Pi's own /compact refuses a session smaller than it; the engine's cut does not use it.
		settings: { compaction: { enabled: false, keepRecentTokens: 2_000 } },
		...(sessionManager ? { sessionManager } : {}),
		extensionFactories: [
			workExtension,
			(pi: ExtensionAPI) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.memo = host.memo;
					if (host.other !== undefined) event.systemPromptOptions.sections.other = host.other;
				});
				pi.on("context_with_system", (event) =>
					injector.on
						? {
								messages: [
									...event.messages.filter((m) => !injector.dropSystem || m.role !== "system"),
									{ role: "user", content: [{ type: "text", text: "injected" }], timestamp: Date.now() },
								],
							}
						: undefined,
				);
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
	let harness: Harness;
	try {
		harness = await created;
	} finally {
		clock?.mockRestore();
		random?.mockRestore();
	}
	await harness.session.bindExtensions({});
	if (!handle) throw new Error("engine not installed");
	const model = scriptedModel(harness, 400);
	// The section as the provider receives it: every system message of the request, merged.
	const memos: string[] = [];
	/** Per request: the whole system prompt as merged, and the first message's own text (its leading prompt). */
	const prompts: Array<{ merged: string; first: string; firstRole: string }> = [];
	/** The engine's cut count when each request was sent: a request that raised it is a cut request. */
	const cutsAt: number[] = [];
	const inner = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (m, context, options) => {
		const merged = getCurrentSystemMessage(context.messages as Message[]);
		const head = context.messages[0] as Message;
		prompts.push({
			merged: merged ? getSystemMessageText(merged) : "",
			first: head?.role === "system" ? getSystemMessageText(head) : "",
			firstRole: head?.role ?? "",
		});
		const memo = merged?.sections?.memo ?? "";
		// Pi's shape exactly: "<memo>\n<content>\n</memo>"; anything else is recorded as is, and fails.
		const wrapped = /^<memo>\n([\s\S]*)\n<\/memo>$/.exec(memo);
		memos.push(wrapped ? wrapped[1] : `unwrapped: ${memo}`);
		cutsAt.push(stats.cuts.length);
		return inner(m, context, options);
	};
	const isCut = (i: number) => cutsAt[i] > (i > 0 ? cutsAt[i - 1] : 0);
	return { harness, stats, lines, model, memos, prompts, isCut, handle: handle as EngineHandle };
}

describe("a system prompt section changes only at a cut (E8.14)", () => {
	it("the engine wraps a section as Pi's system prompt builder does, and omits an empty one as Pi does", () => {
		for (const content of ["C", "two\nlines", "<inner>tag</inner>", ""])
			expect(systemPromptSection("penpi-memory", content), JSON.stringify(content)).toBe(
				buildSystemPromptSections({ cwd: "/work", sections: { "penpi-memory": content } })["penpi-memory"],
			);
	});

	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("an empty section set at a cut leaves the section out, as Pi does", async () => {
		host.memo = "A";
		const t = await session();
		harnesses.push(t.harness);
		t.model.push(finalTurn("one"));
		await t.harness.session.prompt("task 1: a short question.");
		t.handle.setSectionAtNextCut("memo", "");
		for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 1_000 + i));
		t.model.push(finalTurn("two"));
		await t.harness.session.prompt("task 2: process the batch.");
		expect(t.stats.cuts.length).toBeGreaterThan(0);
		expect(t.memos.at(-1)).toBe("unwrapped: ");
		expect(t.prompts.at(-1)?.merged).not.toContain("<memo>");
		expect(t.handle.appliedSection("memo")).toBe("");
	});

	it("F2: a manual /compact sizes its cut with the pending section, so the next request does not cut again", async () => {
		host.memo = "A";
		// 64k window: budget 60,000, cut above 45,000, down to 27,000. Pi compacts only a session larger than
		// its keep-recent size, so the window is filled to about 36,000 tokens (12 results of 12,000 characters).
		const t = await session(undefined, 64_000);
		harnesses.push(t.harness);
		for (let p = 0; p < 4; p++) {
			for (let i = 0; i < 3; i++) t.model.push(toolTurn(12_000, 300 + 10 * p + i));
			t.model.push(finalTurn(`filled ${p}`));
			await t.harness.session.prompt(`task 1.${p}: process the batch.`);
		}
		expect(t.stats.cuts).toHaveLength(0);
		// A large refreshed section is pending: about 35,000 tokens, so without F2 the next request is clearly
		// above the 45,000 high water (about 50,000), not at its edge.
		const lines: string[] = [];
		for (let k = 0; textTokens(lines.join("\n")) < 35_000; k++)
			lines.push(`Memory note ${k}: module ${k % 41} keeps its fixtures next to its tests and runs them first.`);
		t.handle.setSectionAtNextCut("memo", lines.join("\n"));
		const compactError = await t.harness.session.compact().then(
			() => "",
			(e: Error) => e.message,
		);
		expect(compactError).not.toMatch(/Nothing to compact/);
		expect(t.stats.cuts.map((c) => c.where)).toEqual(["manual"]);
		t.model.push(finalTurn("after"));
		await t.harness.session.prompt("task 2: a short question.");
		// The cut was chosen for the prompt it put into effect: the next request needs no second cut, and it is
		// below the high water (45,000) with the 35,000-token section in it.
		expect(t.stats.cuts.map((c) => c.where)).toEqual(["manual"]);
		const last = t.stats.sent.at(-1)!;
		expect(last.estimate * last.ratio).toBeLessThanOrEqual(45_000);
		expect(last.estimate).toBeGreaterThan(35_000);
		expect(t.memos.at(-1)?.startsWith("Memory note 0:")).toBe(true);
	});

	it("Later 4: a system prompt Pi records after a resume supersedes the earlier cut's change, through cuts and rebuilds", async () => {
		host.memo = "A";
		const first = await session(undefined, 32_000, true);
		harnesses.push(first.harness);
		first.model.push(finalTurn("one"));
		await first.harness.session.prompt("task 1: a short question.");
		first.handle.setSectionAtNextCut("memo", "C");
		for (let t = 0; t < 20; t++) first.model.push(toolTurn(6_000, 500 + t));
		first.model.push(finalTurn("two"));
		await first.harness.session.prompt("task 2: process the batch.");
		expect(first.memos.at(-1)).toBe("C");
		// Resume in a new harness: here Pi records the host's system prompt ("A") at the resumed session's first
		// prompt, newer than the earlier cut's change, so "A" wins and stays (the engine drops the superseded
		// change). When Pi records nothing (an unchanged diff), the change carries over: see N6.
		const resumed = await session(first.harness.sessionManager, 32_000, true);
		harnesses.push(resumed.harness);
		resumed.model.push(finalTurn("three"));
		await resumed.harness.session.prompt("task 3: a short question.");
		const systems = resumed.harness.sessionManager
			.getBranch()
			.filter((e) => e.type === "message" && e.message.role === "system");
		expect(systems).toHaveLength(2);
		expect(resumed.memos).toEqual(["A"]);
		// A cut in the resumed session, then a rebuild (/compact): "A" throughout, never back to "C".
		for (let t = 0; t < 20; t++) resumed.model.push(toolTurn(6_000, 600 + t));
		resumed.model.push(finalTurn("four"));
		await resumed.harness.session.prompt("task 4: process the next batch.");
		expect(resumed.stats.cuts.length).toBeGreaterThan(0);
		await resumed.harness.session.compact().catch(() => undefined);
		resumed.model.push(finalTurn("five"));
		await resumed.harness.session.prompt("task 5: a short question.");
		expect(resumed.stats.indexRebuilds).toBeGreaterThan(1);
		expect(new Set(resumed.memos)).toEqual(new Set(["A"]));
	});

	it("N6: a session start at which Pi records no system prompt keeps the change through the next cut and a rebuild", async () => {
		host.memo = "A";
		const t = await session();
		harnesses.push(t.harness);
		t.model.push(finalTurn("one"));
		await t.harness.session.prompt("task 1: a short question.");
		t.handle.setSectionAtNextCut("memo", "C");
		for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 800 + i));
		t.model.push(finalTurn("two"));
		await t.harness.session.prompt("task 2: process the batch.");
		expect(t.memos.at(-1)).toBe("C");
		const systems = () =>
			t.harness.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "system").length;
		const before = systems();
		// A session start (bindExtensions again) with an unchanged host text: Pi records only a diff, so nothing.
		await t.harness.session.bindExtensions({});
		t.model.push(finalTurn("three"));
		await t.harness.session.prompt("task 3: a short question.");
		expect(systems(), "Pi recorded no system prompt at the reload").toBe(before);
		expect(t.memos.at(-1)).toBe("C");
		// A cut after the reload, then a rebuild (/compact): the change from before the reload is still sent.
		for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 900 + i));
		t.model.push(finalTurn("four"));
		await t.harness.session.prompt("task 4: process the next batch.");
		await t.harness.session.compact().catch(() => undefined);
		t.model.push(finalTurn("five"));
		await t.harness.session.prompt("task 5: a short question.");
		expect(t.memos.at(-1), "after the rebuild").toBe("C");
		expect(t.handle.appliedSection("memo")).toBe("C");
	});

	it("N6 (round 4): a system message Pi records after the cut for another section does not undo the change at a session start", async () => {
		host.memo = "A";
		host.other = "X";
		try {
			const t = await session();
			harnesses.push(t.harness);
			t.model.push(finalTurn("one"));
			await t.harness.session.prompt("task 1: a short question.");
			t.handle.setSectionAtNextCut("memo", "C");
			for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 850 + i));
			t.model.push(finalTurn("two"));
			await t.harness.session.prompt("task 2: process the batch.");
			expect(t.memos.at(-1)).toBe("C");
			const systems = () =>
				t.harness.sessionManager
					.getBranch()
					.flatMap((e) => (e.type === "message" && e.message.role === "system" ? [e.message] : []));
			const before = systems().length;
			// Another section changes: Pi records a diff of that section only, after the cut.
			host.other = "Y";
			await t.harness.session.bindExtensions({});
			t.model.push(finalTurn("three"));
			await t.harness.session.prompt("task 3: a short question.");
			const recorded = systems().slice(before);
			expect(recorded, "Pi recorded one system message after the cut").toHaveLength(1);
			expect(Object.keys((recorded[0] as { sections?: object }).sections ?? {})).toEqual(["other"]);
			expect(t.memos.at(-1)).toBe("C");
			// The next session start: the recorded diff does not touch memo, so the change still holds.
			await t.harness.session.bindExtensions({});
			t.model.push(finalTurn("four"));
			await t.harness.session.prompt("task 4: a short question.");
			expect(t.memos.at(-1), "after a second session start").toBe("C");
			expect(t.handle.appliedSection("memo")).toBe("C");
			// A cut, then a rebuild (/compact): the change is still sent.
			for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 870 + i));
			t.model.push(finalTurn("five"));
			await t.harness.session.prompt("task 5: process the next batch.");
			await t.harness.session.compact().catch(() => undefined);
			t.model.push(finalTurn("six"));
			await t.harness.session.prompt("task 6: a short question.");
			expect(t.memos.at(-1), "after the rebuild").toBe("C");
		} finally {
			host.other = undefined;
		}
	});

	it("Later 5: a request the engine cannot align (Pi's own messages are sent) keeps the section change", async () => {
		host.memo = "A";
		injector.on = false;
		const t = await session();
		harnesses.push(t.harness);
		t.model.push(finalTurn("one"));
		await t.harness.session.prompt("task 1: a short question.");
		t.handle.setSectionAtNextCut("memo", "C");
		for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 700 + i));
		t.model.push(finalTurn("two"));
		await t.harness.session.prompt("task 2: process the batch.");
		expect(t.memos.at(-1)).toBe("C");
		injector.on = true;
		try {
			t.model.push(finalTurn("three"));
			await t.harness.session.prompt("task 3: a short question.");
		} finally {
			injector.on = false;
		}
		expect(t.stats.alignMismatches).toBeGreaterThan(0);
		expect(t.memos.at(-1), "the fallback request").toBe("C");
		// N0: the same system prompt as a planned request, Pi's preamble first, in the leading system message
		// (providers that send mid-conversation system messages render the first one as the system prompt).
		const planned = t.prompts.at(-2)!;
		const fallback = t.prompts.at(-1)!;
		expect(fallback.merged).toBe(planned.merged);
		expect(fallback.firstRole).toBe("system");
		expect(fallback.first.startsWith("You are an expert coding assistant")).toBe(true);
		expect(fallback.first).toBe(planned.first);
	});

	it("D17: a request the engine cannot align is estimated as sent, with a smaller or a larger section than Pi's own", async () => {
		// About 4,000 tokens of memory: the section Pi's own messages carry and the cut's change differ by that much.
		const notes: string[] = [];
		for (let k = 0; textTokens(notes.join("\n")) < 4_000; k++)
			notes.push(`Memory note ${k}: module ${k % 41} keeps its fixtures next to its tests and runs them first.`);
		const large = notes.join("\n");
		for (const [own, atCut] of [
			[large, "C"],
			["A", large],
		]) {
			host.memo = own;
			injector.on = false;
			const t = await session();
			harnesses.push(t.harness);
			t.model.push(finalTurn("one"));
			await t.harness.session.prompt("task 1: a short question.");
			t.handle.setSectionAtNextCut("memo", atCut);
			for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 800 + i));
			t.model.push(finalTurn("two"));
			await t.harness.session.prompt("task 2: process the batch.");
			const planned = t.stats.calibrationSamples.at(-1)!;
			const logged = t.lines.length;
			injector.on = true;
			try {
				t.model.push(finalTurn("three"));
				await t.harness.session.prompt("task 3: a short question.");
			} finally {
				injector.on = false;
			}
			const label = own === large ? "smaller section sent" : "larger section sent";
			expect(t.stats.alignMismatches, label).toBeGreaterThan(0);
			expect(t.memos.at(-1)?.slice(0, 20), label).toBe(atCut.slice(0, 20));
			// The fallback's sample (reported over estimated) matches the planned request's: the estimate is of
			// the request as sent, not of Pi's messages with their own copy of the section.
			const fallback = t.stats.calibrationSamples.at(-1)!;
			expect(Math.abs(fallback / planned - 1), `${label}: sample ${fallback} against ${planned}`).toBeLessThan(0.03);
			expect(
				t.lines.slice(logged).filter((l) => l.includes("silent truncation evidence")),
				label,
			).toEqual([]);
		}
	});

	it("N0 (round 4): a request the engine cannot align with no system message older than the cut is sent unchanged", async () => {
		host.memo = "A";
		const t = await session();
		harnesses.push(t.harness);
		t.model.push(finalTurn("one"));
		await t.harness.session.prompt("task 1: a short question.");
		t.handle.setSectionAtNextCut("memo", "C");
		for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 750 + i));
		t.model.push(finalTurn("two"));
		await t.harness.session.prompt("task 2: process the batch.");
		expect(t.memos.at(-1)).toBe("C");
		Object.assign(injector, { on: true, dropSystem: true });
		try {
			t.model.push(finalTurn("three"));
			await t.harness.session.prompt("task 3: a short question.");
		} finally {
			Object.assign(injector, { on: false, dropSystem: false });
		}
		expect(t.stats.alignMismatches).toBeGreaterThan(0);
		// Not the section alone as a leading system message: the messages as they came, with no system message.
		const fallback = t.prompts.at(-1)!;
		expect(fallback.firstRole).toBe("user");
		expect(fallback.merged).toBe("");
	});

	it("arrives with the first cut request, survives an older copy in the window and a rebuild; a resume starts fresh", async () => {
		host.memo = "A";
		const first = await session();
		harnesses.push(first.harness);
		// Two runs with cuts and no change pending.
		first.model.push(finalTurn("one"));
		await first.harness.session.prompt("task 1: a short question.");
		for (let t = 0; t < 20; t++) first.model.push(toolTurn(6_000, t));
		first.model.push(finalTurn("two"));
		await first.harness.session.prompt("task 2: process the batch.");
		const cutsBefore = first.stats.cuts.length;
		expect(cutsBefore).toBeGreaterThan(0);
		expect(new Set(first.memos)).toEqual(new Set(["A"]));
		first.handle.setSectionAtNextCut("memo", "C");
		// The host records "B" at the next prompt: a copy older than the change, recorded at the start of the
		// run in which the next cut happens, so the window that cut keeps contains it.
		host.memo = "B";
		const runStart = first.memos.length;
		// D26: turns of 2,500 (were 3,000): the larger header moves the cut, and the kept window must still start
		// before this run's copy of "B".
		for (let t = 0; t < 20; t++) first.model.push(toolTurn(2_500, 100 + t));
		first.model.push(finalTurn("three"));
		await first.harness.session.prompt("task 3: process the next batch.");
		expect(first.stats.cuts.length).toBeGreaterThan(cutsBefore);
		const changeAt = first.memos.indexOf("C");
		expect(changeAt).toBeGreaterThan(runStart);
		expect(first.isCut(changeAt), "the change arrives with a cut request").toBe(true);
		for (let i = runStart; i < changeAt; i++)
			expect(first.isCut(i), `request ${i}: no cut before the change`).toBe(false);
		expect(first.memos.slice(runStart, changeAt)).toEqual(first.memos.slice(runStart, changeAt).map(() => "B"));
		expect(first.memos.slice(changeAt)).toEqual(first.memos.slice(changeAt).map(() => "C"));
		expect(first.handle.appliedSection("memo")).toBe("C");
		// The copy of "B" is in the kept window: it is a system message after the cut's first kept entry.
		const branch = first.harness.sessionManager.getBranch();
		const cutEntry = branch.find(
			(e) =>
				e.type === "custom" &&
				(e.data as { sections?: unknown; kind?: string }).kind === "cut" &&
				(e.data as { sections?: unknown }).sections,
		);
		const kept = branch.findIndex(
			(e) =>
				e.id ===
				(cutEntry?.type === "custom" ? (cutEntry.data as { firstKeptEntryId: string }).firstKeptEntryId : ""),
		);
		const copyOfB = branch.findIndex(
			(e) => e.type === "message" && e.message.role === "system" && JSON.stringify(e.message).includes("\\nB\\n"),
		);
		expect(kept).toBeGreaterThanOrEqual(0);
		expect(copyOfB, "the older copy is inside the kept window").toBeGreaterThan(kept);
		first.model.push(finalTurn("four"));
		await first.harness.session.prompt("task 4: a short question.");
		expect(first.memos.at(-1)).toBe("C");

		// A rebuilt window (a manual /compact cuts and rebuilds the index) sends the same prompt: the cut entry
		// carries the change, and the older copy in the window is still overridden.
		const rebuildsBefore = first.stats.indexRebuilds;
		// The engine cancels the compaction (it throws "Compaction cancelled") after advancing the window.
		await first.harness.session.compact().catch(() => undefined);
		first.model.push(finalTurn("five"));
		await first.harness.session.prompt("task 5: a short question.");
		expect(first.stats.cuts.some((c) => c.where === "manual")).toBe(true);
		expect(first.stats.indexRebuilds).toBeGreaterThan(rebuildsBefore);
		expect(first.memos.at(-1)).toBe("C");

		// Resume: Pi records the host's system prompt again for the new runtime, newer than the change, so the
		// new session starts from the host's own text (PENpi orients again at a session start).
		const resumed = await session(first.harness.sessionManager);
		harnesses.push(resumed.harness);
		resumed.model.push(finalTurn("six"));
		await resumed.harness.session.prompt("task 6: a short question.");
		expect(resumed.memos).toEqual(["B"]);
		expect(resumed.handle.appliedSection("memo")).toBeUndefined();
	});
});
