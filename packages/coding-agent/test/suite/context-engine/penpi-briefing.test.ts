/**
 * Port (ADR 0032, behaviour change from 0.4): PENpi's orientation briefing (its protocol and Penfield's
 * awaken + reflect) is a system prompt section, set through before_agent_start, never a message. A message
 * would leave the model's view at the engine's first cut; FIFO used to protect it.
 *
 * Against a real session with PENpi (stub Penfield client) and the engine:
 *   - the briefing is in every request, before and after cuts;
 *   - it is never sent as a message;
 *   - the system prompt stays the same for the whole session: one system message carries the section, and
 *     every request has the same system text (the provider's prompt cache holds);
 *   - the engine's budget counts it: the first request's estimate grows by the briefing's estimated size;
 *   - a resumed 0.4 session's penpi-briefing messages stay in the session but are never sent.
 * The engine is installed as PENpi installs it (installPenpiEngine).
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getSystemMessageText,
	type Message,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionFactory,
	type LoadExtensionsResult,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installPenpiEngine } from "../../../../../.pi/extensions/penpi/engine/entry.ts";
import type { EngineHandle } from "../../../../../.pi/extensions/penpi/engine/index.ts";
import { penpiCore } from "../../../../../.pi/extensions/penpi/index.ts";
import { searchTranscripts } from "../../../../../.pi/extensions/penpi/transcript-search.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";
import { STATE_TYPE, textTokens } from "./engine.ts";
import { finalTurn, installProviderSim, reloadKeepingFaux, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const MARK = "PENFIELD-ORIENTATION-MARK";
const BRIEFING = `${MARK} ${"The user prefers small commits and tests before refactors. ".repeat(60)}`;

/**
 * Penfield's memory as the stub serves it: `memory.version` changes it between prompts; `texts` replaces the
 * briefing and the reflection (D18).
 */
const memory: {
	version: number;
	reads: number;
	texts?: { briefing: string; reflection: string };
	/** D25: while set, a read waits for it (a Penfield read still running). */
	gate?: Promise<void>;
} = {
	version: 1,
	reads: 0,
};
const VERSION_MARK = (v: number) => `MEMORY-VERSION-${v}`;

function stubClient() {
	return {
		connected: true,
		hasNonInteractiveAuth: () => true,
		getAccessToken: async () => "jwt",
		connect: async () => {},
		disconnect: async () => {},
		awaken: async () => {
			memory.reads++;
			if (memory.gate) await memory.gate;
			const text = memory.texts?.briefing ?? `${BRIEFING} ${VERSION_MARK(memory.version)}`;
			return { isError: false, data: { briefing: text }, text };
		},
		reflect: async () => ({
			isError: false,
			data: "r",
			text: memory.texts?.reflection ?? "Recent: finished the parser.",
		}),
		saveContext: async () => ({ isError: false, data: "", text: "" }),
		login: async () => "jwt",
	};
}

/** A 0.4 PENpi session: it appended a penpi-briefing message at every session start. */
const OLD_MARK = "OLD-04-BRIEFING-MARK";
/** A user message from a 0.4 session: no input source recorded (0.5 records one per typed message). */
const UNRECORDED_MARK = "UNRECORDED-04-USER-MARK";
function penpi04Briefings(count: number) {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", () => {
			for (let i = 0; i < count; i++)
				pi.sendMessage(
					{
						customType: "penpi-briefing",
						content: `${OLD_MARK} ${i} ${"old orientation text. ".repeat(80)}`,
						display: false,
					},
					{ triggerTurn: false },
				);
		});
	};
}

async function session(
	withPenpi: boolean,
	oldBriefings = 0,
	settings: Record<string, unknown> = {},
	texts?: { briefing: string; reflection: string },
	sessionManager?: SessionManager,
	/** D20: bind the command actions, so a command's ctx.reload() reloads the session as Pi does. */
	reloadable = false,
	contextWindow = 32_000,
) {
	memory.version = 1;
	memory.reads = 0;
	memory.texts = texts;
	let engine: EngineHandle | undefined;
	const install = (api: ExtensionAPI) => {
		engine = installPenpiEngine(api, { registerCommand: false }, { settings, env: {} });
		return engine;
	};
	const factories: ExtensionFactory[] = [
		workExtension,
		...(oldBriefings > 0 ? [penpi04Briefings(oldBriefings)] : []),
		withPenpi
			? (pi) =>
					penpiCore(pi, {
						makeClient: () => stubClient() as never,
						ensureMcpEntry: () => "/tmp/penpi-briefing-test-mcp.json",
						installEngine: install,
					})
			: (pi) => void install(pi),
	];
	// D20: as Pi's own loader, a reload loads the extensions again (new PENpi and engine instances); the test
	// loader's reload keeps the old ones.
	let loaded = reloadable ? await createTestExtensionsResult(factories) : undefined;
	const reloading = loaded
		? {
				...createTestResourceLoader(),
				getExtensions: () => loaded as LoadExtensionsResult,
				reload: async () => {
					loaded = await createTestExtensionsResult(factories);
				},
			}
		: undefined;
	const harness: Harness = await createHarness({
		models: [{ id: `faux-${contextWindow / 1000}k`, contextWindow, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		...(sessionManager ? { sessionManager } : {}),
		...(reloading ? { resourceLoader: reloading } : { extensionFactories: factories }),
	});
	await harness.session.bindExtensions(
		reloadable
			? {
					commandContextActions: {
						waitForIdle: async () => {},
						newSession: async () => ({ cancelled: true }),
						fork: async () => ({ cancelled: true }),
						navigateTree: async () => ({ cancelled: true }),
						switchSession: async () => ({ cancelled: true }),
						reload: () => reloadKeepingFaux(harness),
					} as never,
				}
			: {},
	);
	if (!engine) throw new Error("engine not installed");
	return { harness, stats: engine.stats, model: scriptedModel(harness, 400) };
}

const systemText = (request: string[]) => request.filter((m) => m.includes('"role":"system"')).join("\n");

describe("PENpi's orientation briefing is a system prompt section (ADR 0032)", () => {
	it("stays in view after cuts, is never a message, and keeps the system prompt stable", async () => {
		const { harness, stats, model } = await session(true);
		try {
			for (let p = 0; p < 3; p++) {
				for (let t = 0; t < 14; t++) model.push(toolTurn(6_000, p * 100 + t));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`task ${p}: process the next batch.`);
			}
			expect(stats.cuts.length).toBeGreaterThan(1);
			// In every request, before and after each cut.
			expect(model.requests.length).toBeGreaterThan(40);
			for (const [i, request] of model.requests.entries())
				expect(
					request.some((m) => m.includes(MARK)),
					`request ${i + 1}`,
				).toBe(true);
			// Never a message in any request: what carries it is the system prompt only.
			for (const [i, request] of model.requests.entries())
				expect(
					request.filter((m) => m.includes(MARK)).map((m) => (JSON.parse(m) as { role: string }).role),
					`request ${i + 1}: carriers`,
				).toEqual(["system"]);
			// Nor in the transcript: one system message carries it.
			const carriers = harness.session.agent.state.messages.filter((m) => JSON.stringify(m).includes(MARK));
			expect(carriers.map((m) => m.role)).toEqual(["system"]);
			// The same system text in every request.
			const systems = new Set(model.requests.map(systemText));
			expect(systems.size).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("is byte-stable across prompts when Penfield changes with no cut, and refreshed at the next cut", async () => {
		const { harness, stats, model } = await session(true);
		// The system prompt as the provider receives it: every system message of the request, merged.
		const prompts: string[] = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, options) => {
			const system = getCurrentSystemMessage(context.messages as Message[]);
			prompts.push(system ? getSystemMessageText(system) : "");
			return inner(m, context, options);
		};
		try {
			const reads = async (n: number) => vi.waitFor(() => expect(memory.reads).toBeGreaterThanOrEqual(n));
			model.push(finalTurn("one"));
			await harness.session.prompt("task 1: a short question.");
			await reads(2); // the read after run 1
			memory.version = 2; // new memories stored mid-session
			model.push(finalTurn("two"));
			await harness.session.prompt("task 2: another short question.");
			await reads(3); // the read after run 2 sees version 2
			expect(stats.cuts).toHaveLength(0);
			const beforeCut = model.requests.length;
			expect(new Set(model.requests.map(systemText)).size, "same system prompt, no cut").toBe(1);
			expect(systemText(model.requests[0])).toContain(VERSION_MARK(1));
			// A long run: the engine cuts, and the refreshed briefing arrives with the cut.
			for (let t = 0; t < 30; t++) model.push(toolTurn(6_000, t));
			model.push(finalTurn("three"));
			await harness.session.prompt("task 3: process the batch.");
			model.push(finalTurn("four"));
			await harness.session.prompt("task 4: one more short question.");
			expect(stats.cuts.length).toBeGreaterThan(0);
			const firstCut = model.requests.findIndex((r) => r.some((m) => m.includes("[context window #1]")));
			const firstNew = model.requests.findIndex((r) => systemText(r).includes(VERSION_MARK(2)));
			expect(firstCut).toBeGreaterThan(beforeCut);
			expect(firstNew, "the refresh arrives at the first cut, not before or after").toBe(firstCut);
			// The system prompt changes once, at that cut, and stays the same afterwards (task 4 included).
			const systems = model.requests.map(systemText);
			const changes = systems.flatMap((text, i) => (i > 0 && text !== systems[i - 1] ? [i] : []));
			expect(changes).toEqual([firstCut]);
			for (const text of systems.slice(firstCut)) {
				expect(text).toContain(VERSION_MARK(2));
				expect(text).not.toContain(VERSION_MARK(1));
			}
			// B1: the refreshed briefing keeps its section tags, exactly once, in every request.
			expect(prompts).toHaveLength(model.requests.length);
			const count = (text: string, part: string) => text.split(part).length - 1;
			for (const [i, prompt] of prompts.entries()) {
				expect(count(prompt, "<penpi-memory>\n"), `request ${i + 1}: opening tag`).toBe(1);
				expect(count(prompt, "\n</penpi-memory>"), `request ${i + 1}: closing tag`).toBe(1);
				expect(prompt.indexOf("<penpi-memory>\n")).toBeLessThan(prompt.indexOf(VERSION_MARK(i < firstCut ? 1 : 2)));
				expect(prompt.indexOf("\n</penpi-memory>")).toBeGreaterThan(
					prompt.indexOf(VERSION_MARK(i < firstCut ? 1 : 2)),
				);
			}
		} finally {
			harness.cleanup();
		}
	});

	it("D18: two worst-case memory texts stay within the section's token cap on a 32k model, and requests fit", async () => {
		// Escapes (each < is six characters as encoded) and CJK: each text fills the 64,000-character cap.
		const texts = { briefing: "<".repeat(64_000), reflection: "記憶の断片、".repeat(20_000) };
		const { harness, stats, model } = await session(true, 0, {}, texts);
		const sectionOf = () =>
			getCurrentSystemMessage(harness.session.agent.state.messages as Message[])?.sections?.["penpi-memory"] ?? "";
		try {
			for (let p = 0; p < 3; p++) {
				for (let t = 0; t < 10; t++) model.push(toolTurn(4_000, 500 + p * 100 + t));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`task ${p}: process the next batch.`);
			}
			const section = sectionOf();
			expect(section).toContain("\\u003c");
			expect(section).toContain("記憶");
			// 20% of the 32,000-token planning window.
			expect(textTokens(section), "the section in the engine's estimate").toBeLessThanOrEqual(6_400);
			// Every request fits: below the window as the provider counts it, and planned within the budget.
			expect(Math.max(...model.promptTokens), "largest request").toBeLessThan(32_000);
			for (const [i, sent] of stats.sent.entries())
				expect(sent.estimate * sent.ratio, `request ${i + 1}`).toBeLessThanOrEqual(sent.budget * 1.02);
			expect(stats.providerErrors).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("D18 at session start: the first briefing is capped for the session's model (24k on 200k, about 6.4k on 32k)", async () => {
		// Plain memory, two texts at the 64,000-character cap: about 32,000 tokens, over both caps.
		const notes: string[] = [];
		for (let k = 0; notes.join("\n").length < 64_000; k++)
			notes.push(`Memory note ${k}: module ${k % 41} keeps its fixtures next to its tests and runs them first.`);
		const text = notes.join("\n").slice(0, 64_000);
		for (const [window, cap] of [
			[200_000, 24_000],
			[32_000, 6_400],
		]) {
			const { harness, model } = await session(
				true,
				0,
				{},
				{ briefing: text, reflection: text },
				undefined,
				false,
				window,
			);
			try {
				// Orientation ran at session_start; the first run's system prompt carries the section.
				model.push(finalTurn("one"));
				await harness.session.prompt("task 1: a short question.");
				const section =
					getCurrentSystemMessage(harness.session.agent.state.messages as Message[])?.sections?.["penpi-memory"] ??
					"";
				const tokens = textTokens(section);
				expect(tokens, `${window}: the section in the engine's estimate`).toBeLessThanOrEqual(cap);
				expect(tokens, `${window}: the section uses its cap, not the 32,768 default's`).toBeGreaterThan(cap * 0.9);
			} finally {
				harness.cleanup();
			}
		}
	});

	it("D19: ten changed refreshes grow the session file by under 10 KB, cuts record sections only when they change, and search returns no state entry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-d19-"));
		const { harness, stats, model } = await session(true, 0, {}, undefined, SessionManager.create(dir, dir));
		try {
			const file = harness.session.sessionManager.getSessionFile();
			if (!file) throw new Error("no session file");
			const entries = () =>
				readFileSync(file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as {
								type: string;
								customType?: string;
								data?: { kind?: string; sections?: unknown };
							},
					);
			model.push(finalTurn("ready"));
			await harness.session.prompt("task 0: a short question.");
			// Ten runs, Penfield's memory changed before each: every run's refresh has a new briefing to record.
			const before = statSync(file).size;
			for (let v = 2; v <= 11; v++) {
				memory.version = v;
				model.push(finalTurn(`ok ${v}`));
				await harness.session.prompt(`q ${v}`);
			}
			expect(memory.reads).toBeGreaterThanOrEqual(11);
			expect(stats.cuts).toHaveLength(0);
			// What the file gained beyond the ten runs' own messages (their prompts and answers): the refresh
			// records and the engine's per-run state.
			let offset = 0;
			let growth = 0;
			for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
				const at = offset;
				offset += Buffer.byteLength(line) + 1;
				if (at >= before && (JSON.parse(line) as { type: string }).type !== "message")
					growth += Buffer.byteLength(line) + 1;
			}
			expect(growth, "session file growth over ten refreshes, beyond the runs' messages (bytes)").toBeLessThan(
				10_000,
			);
			// Memory unchanged from here: the first cut puts the last refresh into effect, later cuts change nothing.
			for (let p = 0; p < 3; p++) {
				for (let t = 0; t < 14; t++) model.push(toolTurn(6_000, 900 + p * 100 + t));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`task ${p + 1}: process the next batch.`);
			}
			const cuts = entries().filter((e) => e.customType === STATE_TYPE && e.data?.kind === "cut");
			expect(cuts.length).toBeGreaterThan(1);
			expect(
				cuts.map((e) => e.data?.sections !== undefined),
				"cut entries carrying sections",
			).toEqual(cuts.map((_e, i) => i === 0));
			// The memory text is only in the system prompt: no state entry is a search result.
			const found = await searchTranscripts(dir, VERSION_MARK(11), { limit: 50 });
			expect(found.matches.filter((m) => m.role.startsWith("custom:"))).toEqual([]);
			const anyMemory = await searchTranscripts(dir, "small commits", { limit: 50 });
			expect(anyMemory.matches.filter((m) => m.role.startsWith("custom:"))).toEqual([]);
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("D20: /penpi login mid-session changes the briefing at the next cut, and the login text holds through it", async () => {
		const { harness, model } = await session(true, 0, {}, undefined, undefined, true);
		try {
			const reads = async (n: number) => vi.waitFor(() => expect(memory.reads).toBeGreaterThanOrEqual(n));
			model.push(finalTurn("one"));
			await harness.session.prompt("task 1: a short question.");
			await reads(2);
			// A refresh: version 2 is handed to the engine for its next cut.
			memory.version = 2;
			model.push(finalTurn("two"));
			await harness.session.prompt("task 2: another short question.");
			await reads(3);
			// Login reads version 3 (and reloads the extensions).
			memory.version = 3;
			await harness.session.prompt("/penpi login");
			await reads(4);
			const afterLogin = model.requests.length;
			model.push(finalTurn("three"));
			await harness.session.prompt("task 3: a short question.");
			// No cut yet: the system prompt is the one before the login (the provider's cache holds).
			expect(systemText(model.requests[afterLogin]), "the request after the login, before a cut").toBe(
				systemText(model.requests[afterLogin - 1]),
			);
			expect(systemText(model.requests[afterLogin])).toContain(VERSION_MARK(1));
			// Two long runs with cuts: the login text arrives with the first and holds through the second.
			for (let p = 0; p < 2; p++) {
				for (let t = 0; t < 20; t++) model.push(toolTurn(6_000, 1_000 + p * 100 + t));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`task ${p + 4}: process the batch.`);
			}
			const cutAt = (n: number) =>
				model.requests.findIndex((r) => r.some((m) => m.includes(`[context window #${n}]`)));
			expect(cutAt(2), "a second cut").toBeGreaterThan(0);
			const systems = model.requests.map(systemText);
			const changes = systems.flatMap((text, i) => (i > 0 && text !== systems[i - 1] ? [i] : []));
			expect(changes, "the system prompt changes once, at the first cut").toEqual([cutAt(1)]);
			for (const text of systems.slice(cutAt(1))) {
				expect(text).toContain(VERSION_MARK(3));
				expect(text).not.toContain(VERSION_MARK(2));
			}
		} finally {
			harness.cleanup();
		}
	});

	it("D20: a login whose text is the session-start text still replaces an earlier refresh at the next cut", async () => {
		const { harness, model } = await session(true, 0, {}, undefined, undefined, true);
		try {
			const reads = async (n: number) => vi.waitFor(() => expect(memory.reads).toBeGreaterThanOrEqual(n));
			const longRun = async (seed: number, label: string) => {
				for (let t = 0; t < 20; t++) model.push(toolTurn(6_000, seed + t));
				model.push(finalTurn(label));
				await harness.session.prompt(`${label}: process the batch.`);
			};
			model.push(finalTurn("one"));
			await harness.session.prompt("task 1: a short question.");
			await reads(2);
			// A refresh to version 2, in effect from the next cut.
			memory.version = 2;
			model.push(finalTurn("two"));
			await harness.session.prompt("task 2: another short question.");
			await reads(3);
			await longRun(2_000, "task 3");
			expect(systemText(model.requests.at(-1) ?? [])).toContain(VERSION_MARK(2));
			// Penfield is back at version 1, the session-start text: Pi records no change for it.
			memory.version = 1;
			await harness.session.prompt("/penpi login");
			await reads(5);
			const afterLogin = model.requests.length;
			await longRun(3_000, "task 4");
			await longRun(4_000, "task 5");
			const systems = model.requests.slice(afterLogin).map(systemText);
			const firstLogin = systems.findIndex((text) => text.includes(VERSION_MARK(1)));
			expect(firstLogin, "the login text arrives").toBeGreaterThan(0);
			expect(
				model.requests[afterLogin + firstLogin].some((m) => m.includes("[context window #")),
				"at a cut",
			).toBe(true);
			for (const text of systems.slice(firstLogin)) expect(text).not.toContain(VERSION_MARK(2));
		} finally {
			harness.cleanup();
		}
	});

	it("context_search does not return a resumed 0.4 session's briefing messages (memory, outside the fence)", async () => {
		const { harness, model } = await session(true, 2);
		try {
			let found = "";
			model.push(() =>
				fauxAssistantMessage([fauxToolCall("context_search", { query: OLD_MARK, scope: "all" }, { id: "s-1" })], {
					stopReason: "toolUse",
				}),
			);
			model.push((context) => {
				const last = context.messages.at(-1);
				found =
					last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
				return fauxAssistantMessage("done");
			});
			await harness.session.prompt("look up the old orientation.");
			expect(found).toMatch(/^\[context_search /);
			// Only the query is echoed in the result's first line: no entry is a hit.
			expect(found).toContain("0 entries match");
			expect(found.split("\n").filter((line) => line.includes(OLD_MARK))).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("counts toward the engine's budget: the estimate grows by the briefing's size", async () => {
		const first = async (withPenpi: boolean) => {
			const { harness, stats, model } = await session(withPenpi);
			try {
				model.push(finalTurn("ok"));
				await harness.session.prompt("task: start.");
				return { estimate: stats.sent[0].estimate, system: systemText(model.requests[0]) };
			} finally {
				harness.cleanup();
			}
		};
		const without = await first(false);
		const withBriefing = await first(true);
		expect(withBriefing.system).toContain(MARK);
		expect(without.system).not.toContain(MARK);
		// PENpi also registers its tools and command, so compare against the size of the whole difference
		// in system text; the briefing is most of it.
		const briefingTokens = textTokens(BRIEFING);
		const grown = withBriefing.estimate - without.estimate;
		expect(grown).toBeGreaterThanOrEqual(briefingTokens);
		const systemGrowth = textTokens(withBriefing.system) - textTokens(without.system);
		expect(Math.abs(grown - systemGrowth)).toBeLessThanOrEqual(Math.max(50, systemGrowth * 0.15));
	});

	it("never sends or pins a resumed 0.4 session's penpi-briefing messages, which stay in the session", async () => {
		// unrecordedSource "pin" (the default, set here explicitly): user messages with no recorded source are
		// carried. A 0.4 session's user message has none, so the pin carries it; its briefings are not user
		// messages (every PENpi version sent them as penpi-briefing custom messages), so it never does.
		const { harness, stats, model } = await session(true, 2, { pinUserMessages: { unrecordedSource: "pin" } });
		try {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `${UNRECORDED_MARK} keep the public API stable.` }],
				timestamp: Date.now(),
			});
			const stored = harness.session.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom_message" && e.customType === "penpi-briefing");
			expect(stored).toHaveLength(2);
			for (let t = 0; t < 30; t++) model.push(toolTurn(6_000, t));
			model.push(finalTurn("done"));
			await harness.session.prompt("task: process the batch.");
			expect(stats.cuts.length).toBeGreaterThan(0);
			expect(stats.alignMismatches).toBe(0);
			const pinned = model.requests.flatMap((r) => r.filter((m) => m.includes("<pinned-user-messages>")));
			expect(pinned.length, "the pin was in the requests after the cut").toBeGreaterThan(0);
			for (const block of pinned) {
				expect(block).toContain(UNRECORDED_MARK);
				expect(block).not.toContain(OLD_MARK);
			}
			for (const [i, request] of model.requests.entries()) {
				expect(
					request.some((m) => m.includes(OLD_MARK)),
					`request ${i + 1}: old briefing`,
				).toBe(false);
				expect(
					request.some((m) => m.includes(MARK)),
					`request ${i + 1}: current briefing`,
				).toBe(true);
			}
		} finally {
			harness.cleanup();
		}
	});
});

/**
 * D25 (external review CR1): the memory section is capped for the model of the moment (D18), but it was composed
 * only at orientation and at the refresh after a run. After the effective window shrank (a smaller model selected,
 * a resume on a smaller model, a window learned from an overflow), the next requests kept the larger section and
 * every one overflowed: the cuts can drop history, not the system prompt. The engine now re-caps the section before
 * the first request after the shrink and applies it at a cut there, recorded in the cut entry.
 * Every session here sits behind a provider that rejects any request above the selected model's window.
 */
describe("D25: the memory section is re-capped before the first request after the window shrinks", () => {
	// Plain memory, two texts at the 64,000-character cap: about 32,000 tokens, over every cap here.
	const notes: string[] = [];
	for (let k = 0; notes.join("\n").length < 64_000; k++)
		notes.push(`Memory note ${k}: module ${k % 41} keeps its fixtures next to its tests and runs them first.`);
	const BIG = notes.join("\n").slice(0, 64_000);
	const texts = (tag: string) => ({ briefing: `${tag} ${BIG}`, reflection: BIG });

	/** While on, another extension adds a message to every request, which the engine then cannot align (N2). */
	const injector = { on: false };
	async function shrinkSession(windows: number[], sessionManager?: SessionManager, tag = "MEMORY-A") {
		injector.on = false;
		memory.version = 1;
		memory.reads = 0;
		memory.gate = undefined;
		memory.texts = texts(tag);
		let engine: EngineHandle | undefined;
		const harness = await createHarness({
			models: windows.map((w) => ({ id: `faux-${w / 1000}k`, contextWindow: w, maxTokens: 2_000 })),
			settings: { compaction: { enabled: false } },
			...(sessionManager ? { sessionManager } : {}),
			extensionFactories: [
				workExtension,
				(pi) => {
					pi.on("context_with_system", (event) =>
						injector.on
							? {
									messages: [
										...event.messages,
										{ role: "user", content: [{ type: "text", text: "injected" }], timestamp: Date.now() },
									],
								}
							: undefined,
					);
				},
				(pi) =>
					penpiCore(pi, {
						makeClient: () => stubClient() as never,
						ensureMcpEntry: () => "/tmp/penpi-briefing-test-mcp.json",
						installEngine: (api) => {
							engine = installPenpiEngine(api, { registerCommand: false }, { settings: {}, env: {} });
							return engine;
						},
					}),
			],
		});
		await harness.session.bindExtensions({});
		if (!engine) throw new Error("engine not installed");
		const sim = installProviderSim(harness, { realLimit: (_i, _tokens, model) => model.contextWindow });
		const model = scriptedModel(harness, 400);
		const sectionOfLast = () => {
			const request = model.requests.at(-1) ?? [];
			const system = request.find((m) => m.includes('"role":"system"')) ?? "";
			const sections = (JSON.parse(system || "{}") as { sections?: Record<string, string> }).sections ?? {};
			return sections["penpi-memory"] ?? "";
		};
		return { harness, engine, sim, model, sectionOfLast };
	}
	const select = async (t: Awaited<ReturnType<typeof shrinkSession>>, id: string) => {
		const next = t.harness.getModel(id);
		if (!next) throw new Error(`no model ${id}`);
		await t.harness.session.setModel(next);
	};
	const rejected = (t: Awaited<ReturnType<typeof shrinkSession>>, id: string) =>
		t.sim.calls.filter((c) => c.model === id && c.rejected).length;

	it("1. control: a cold start on the 8k model caps the section for it and fits", async () => {
		const t = await shrinkSession([8_000, 200_000]);
		try {
			t.model.push(finalTurn("ready"));
			await t.harness.session.prompt("task 1: a short question.");
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
			expect(rejected(t, "faux-8k")).toBe(0);
		} finally {
			t.harness.cleanup();
		}
	});

	it("2. 200k -> 8k: the first run on the smaller model has no rejected request", async () => {
		const t = await shrinkSession([200_000, 8_000]);
		try {
			t.model.push(finalTurn("large ready"));
			await t.harness.session.prompt("task 1: a short question.");
			expect(textTokens(t.sectionOfLast())).toBeGreaterThan(8_000);
			await select(t, "faux-8k");
			t.model.push(finalTurn("small ready"));
			await t.harness.session.prompt("task 2: another short question.");
			expect(t.sim.calls.filter((c) => c.model === "faux-8k").length).toBeGreaterThan(0);
			expect(rejected(t, "faux-8k"), "requests to the 8k model rejected").toBe(0);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
			expect(t.sectionOfLast()).toContain("MEMORY-A");
			expect(t.engine.stats.sectionRecaps).toBe(1);
		} finally {
			t.harness.cleanup();
		}
	});

	it("3. 200k -> 8k with a refresh pending: the first small run fits, and the newer memory is the one re-capped", async () => {
		const t = await shrinkSession([200_000, 8_000]);
		try {
			const reads = async (n: number) => vi.waitFor(() => expect(memory.reads).toBeGreaterThanOrEqual(n));
			t.model.push(finalTurn("large ready"));
			await t.harness.session.prompt("task 1: a short question.");
			memory.texts = texts("MEMORY-B");
			t.model.push(finalTurn("again"));
			await t.harness.session.prompt("task 2: a short question.");
			await reads(3); // the refresh after task 2 read MEMORY-B: pending, for the next cut
			await select(t, "faux-8k");
			t.model.push(finalTurn("small ready"));
			await t.harness.session.prompt("task 3: another short question.");
			expect(rejected(t, "faux-8k")).toBe(0);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
			expect(t.sectionOfLast()).toContain("MEMORY-B");
		} finally {
			t.harness.cleanup();
		}
	});

	it("4. 64k -> 8k after a cut already applied a refreshed section: the first small run fits", async () => {
		const t = await shrinkSession([64_000, 8_000]);
		try {
			const reads = async (n: number) => vi.waitFor(() => expect(memory.reads).toBeGreaterThanOrEqual(n));
			t.model.push(finalTurn("ready"));
			await t.harness.session.prompt("task 1: a short question.");
			memory.texts = texts("MEMORY-B");
			await reads(2);
			t.model.push(finalTurn("again"));
			await t.harness.session.prompt("task 2: a short question.");
			await reads(3);
			for (let i = 0; i < 20; i++) t.model.push(toolTurn(6_000, 600 + i));
			t.model.push(finalTurn("batch done"));
			await t.harness.session.prompt("task 3: process the batch.");
			expect(t.engine.stats.cuts.length, "a cut applied MEMORY-B").toBeGreaterThan(0);
			expect(t.sectionOfLast()).toContain("MEMORY-B");
			await select(t, "faux-8k");
			t.model.push(finalTurn("small ready"));
			await t.harness.session.prompt("task 4: another short question.");
			expect(rejected(t, "faux-8k")).toBe(0);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
			expect(t.sectionOfLast()).toContain("MEMORY-B");
		} finally {
			t.harness.cleanup();
		}
	});

	it("5. a session written on 64k resumed on 8k: the first request fits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-d25-"));
		try {
			const first = await shrinkSession([64_000], SessionManager.create(dir, dir));
			const file = first.harness.session.sessionManager.getSessionFile();
			if (!file) throw new Error("no session file");
			first.model.push(finalTurn("ready"));
			await first.harness.session.prompt("task 1: a short question.");
			for (let i = 0; i < 20; i++) first.model.push(toolTurn(6_000, 700 + i));
			first.model.push(finalTurn("batch done"));
			await first.harness.session.prompt("task 2: process the batch.");
			expect(first.engine.stats.cuts.length).toBeGreaterThan(0);
			first.harness.cleanup();
			const second = await shrinkSession([8_000], SessionManager.open(file, dir));
			try {
				second.model.push(finalTurn("resumed"));
				await second.harness.session.prompt("task 3: what were we doing?");
				expect(second.sim.calls.length).toBeGreaterThan(0);
				expect(rejected(second, "faux-8k")).toBe(0);
				expect(textTokens(second.sectionOfLast())).toBeLessThanOrEqual(1_600);
			} finally {
				second.harness.cleanup();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("6. a window learned from an overflow mid-run: the retried request is re-capped and fits", async () => {
		// The model declares 200k; the provider holds 8,000 tokens. The first request (with the 24,000-token
		// section) overflows, the engine learns 8,000, and the retry must fit.
		const t = await shrinkSession([200_000]);
		try {
			t.sim.calls.length = 0;
			const sim = installProviderSim(t.harness, { realLimit: 8_000 });
			t.model.push(finalTurn("ready"));
			await t.harness.session.prompt("task 1: a short question.");
			expect(sim.calls[0]?.rejected, "the first request overflows").toBe(true);
			expect(sim.calls.at(-1)?.rejected, "the retry is accepted").toBe(false);
			expect(sim.calls.filter((c) => c.rejected).length).toBe(1);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
		} finally {
			t.harness.cleanup();
		}
	});

	it("9. a refresh that completes after the shrink composes for the new window: no request over it, then or later", async () => {
		const t = await shrinkSession([200_000, 8_000]);
		try {
			t.model.push(finalTurn("large ready"));
			let release: () => void = () => {};
			memory.gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			memory.texts = texts("MEMORY-B");
			await t.harness.session.prompt("task 1: a short question."); // the refresh after it waits at the gate
			await select(t, "faux-8k");
			t.model.push(finalTurn("small ready"));
			await t.harness.session.prompt("task 2: another short question.");
			expect(rejected(t, "faux-8k"), "the run after the shrink").toBe(0);
			release();
			memory.gate = undefined;
			await vi.waitFor(() => expect(memory.reads).toBeGreaterThanOrEqual(2));
			await new Promise((resolve) => setTimeout(resolve, 20));
			// The refreshed MEMORY-B arrives at the next cut, composed for the 8k window.
			for (let i = 0; i < 6; i++) t.model.push(toolTurn(1_200, 800 + i));
			t.model.push(finalTurn("batch done"));
			await t.harness.session.prompt("task 3: process a small batch.");
			expect(rejected(t, "faux-8k"), "every request on the 8k model").toBe(0);
			expect(t.sectionOfLast()).toContain("MEMORY-B");
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
		} finally {
			memory.gate = undefined;
			t.harness.cleanup();
		}
	});

	it("10. a fork of a session from before its re-cap, opened on the smaller model: the first request fits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-d25-fork-"));
		try {
			const first = await shrinkSession([64_000, 8_000], SessionManager.create(dir, dir));
			const file = first.harness.session.sessionManager.getSessionFile();
			if (!file) throw new Error("no session file");
			first.model.push(finalTurn("ready"));
			await first.harness.session.prompt("task 1: a short question.");
			for (let i = 0; i < 20; i++) first.model.push(toolTurn(6_000, 900 + i));
			first.model.push(finalTurn("batch done"));
			await first.harness.session.prompt("task 2: process the batch.");
			expect(first.engine.stats.cuts.length, "a cut on 64k").toBeGreaterThan(0);
			// The fork point: the last entry before the switch, whose branch holds the 64k cut and its section.
			const forkAt = first.harness.session.sessionManager.getLeafId();
			await select(first, "faux-8k");
			first.model.push(finalTurn("small"));
			await first.harness.session.prompt("task 3: a short question.");
			first.harness.cleanup();
			if (!forkAt) throw new Error("no leaf");
			const forked = SessionManager.open(file, dir).createBranchedSession(forkAt);
			if (!forked) throw new Error("no fork");
			const second = await shrinkSession([8_000], SessionManager.open(forked, dir));
			try {
				second.model.push(finalTurn("forked"));
				await second.harness.session.prompt("task 4: carry on from the fork.");
				expect(second.sim.calls.length).toBeGreaterThan(0);
				expect(rejected(second, "faux-8k")).toBe(0);
				expect(textTokens(second.sectionOfLast())).toBeLessThanOrEqual(1_600);
			} finally {
				second.harness.cleanup();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("11. 200k -> 8k on requests the engine cannot align: the first one fits, and the next aligned one makes the recorded cut", async () => {
		const t = await shrinkSession([200_000, 8_000]);
		try {
			t.model.push(finalTurn("large ready"));
			await t.harness.session.prompt("task 1: a short question.");
			await select(t, "faux-8k");
			injector.on = true;
			t.model.push(finalTurn("small, unaligned"));
			await t.harness.session.prompt("task 2: another short question.");
			injector.on = false;
			expect(t.engine.stats.alignMismatches, "the run's requests were not aligned").toBeGreaterThan(0);
			expect(rejected(t, "faux-8k"), "requests to the 8k model while unaligned").toBe(0);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
			const cutsBefore = t.engine.stats.cuts.length;
			t.model.push(finalTurn("small, aligned"));
			await t.harness.session.prompt("task 3: a short question.");
			expect(rejected(t, "faux-8k")).toBe(0);
			expect(t.engine.stats.cuts.length, "the re-cap's cut, on the aligned request").toBe(cutsBefore + 1);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(1_600);
		} finally {
			injector.on = false;
			t.harness.cleanup();
		}
	});

	it("12. a window learned from silent truncation: the next request is re-capped for it and is no longer truncated", async () => {
		// The model declares 200k; the provider silently keeps 12,000 tokens and reports exactly that. The engine
		// detects it from usage that stops growing, learns 12,000, and must then send requests within it.
		const t = await shrinkSession([200_000]);
		try {
			const sim = installProviderSim(t.harness, { silentLimit: 12_000 });
			for (let i = 0; i < 8; i++) t.model.push(toolTurn(1_200, 950 + i));
			t.model.push(finalTurn("done"));
			await t.harness.session.prompt("task 1: process a small batch.");
			expect(t.engine.stats.plateaus.length, "silent truncation detected").toBeGreaterThan(0);
			expect(t.engine.stats.plateaus[0].window).toBeLessThanOrEqual(12_000);
			expect(t.engine.stats.sectionRecaps).toBeGreaterThan(0);
			const learnedAt = sim.calls.findIndex((c, i) => i > 0 && !c.truncatedInput && sim.calls[i - 1].truncatedInput);
			expect(learnedAt, "a request after the learn that the provider kept whole").toBeGreaterThan(0);
			expect(
				sim.calls.slice(learnedAt).every((c) => !c.truncatedInput),
				"none truncated after it",
			).toBe(true);
			expect(textTokens(t.sectionOfLast())).toBeLessThanOrEqual(2_400);
		} finally {
			t.harness.cleanup();
		}
	});

	it("8. a window too small for the system prompt even at its smallest: refused before any request is sent", async () => {
		const t = await shrinkSession([1_500]);
		try {
			t.model.push(finalTurn("never"));
			await t.harness.session.prompt("task 1: a short question.").catch(() => {});
			// The request was aborted before dispatch: a real provider client sends nothing on an aborted signal.
			expect(t.sim.calls.length).toBeGreaterThan(0);
			expect(
				t.sim.calls.every((c) => c.aborted),
				"every request aborted before dispatch",
			).toBe(true);
			expect(t.harness.faux.state.callCount, "the model was never called").toBe(0);
		} finally {
			t.harness.cleanup();
		}
	});

	it("7. control: the same model throughout, nothing re-capped, the system prompt byte-identical", async () => {
		const t = await shrinkSession([200_000, 8_000]);
		try {
			for (let p = 0; p < 4; p++) {
				t.model.push(finalTurn(`answer ${p}`));
				await t.harness.session.prompt(`task ${p}: a short question.`);
			}
			const systems = new Set(t.model.requests.map(systemText));
			expect(systems.size, "one system prompt").toBe(1);
			expect(t.engine.stats.sectionRecaps).toBe(0);
			expect(t.engine.stats.cuts).toHaveLength(0);
		} finally {
			t.harness.cleanup();
		}
	});
});
