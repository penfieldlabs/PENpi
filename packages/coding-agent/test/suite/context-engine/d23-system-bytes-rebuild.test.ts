/**
 * D23: a window rebuilt without a cut must send the same system prompt, byte for byte, as the in-session window.
 *
 * The rebuild paths named in the spec row: /reload, branch navigation, a context edit, and a request the engine
 * cannot align (Pi's own messages, with the cut's override applied). For each, against a real session with
 * sections changed at cuts: the last request before the rebuild and the first request after it (no cut in
 * between) must carry the same system messages, as the provider receives them (order, content, sections), and
 * the same merged system prompt text. Earlier tests compared only one section's value.
 *
 * Scenarios (the ways a cut's override can meet the session's own system messages):
 *   one       one section changed at a cut, with an older copy of it still in the kept window;
 *   two-cuts  the same section changed again at a later cut (an override over an override);
 *   new       a section that the host's prompt does not have, added at a cut;
 *   pair      two sections changed at one cut, one existing and one new;
 *   mixed     as one, with the older copy's system message also carrying a section the cut does not change;
 *   superseded  as one, then the host sets the section again and a later cut has no override.
 *   tools     no section change: the host turns a second tool on for the run in which the session cuts (Pi records
 *             a tool-change system message in the kept window, older than the cut), then off again (0.6.0, from
 *             the independent review).
 *
 * Paths: the four rebuilds, and `delete`, a context edit that deletes a tool result (the in-session splice, not a
 * rebuild). A system message with text content is not covered: Pi's own mid-session system messages carry only
 * section and tool changes, with empty content.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../../../../../.pi/extensions/penpi/engine/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	finalTurn,
	reloadKeepingFaux,
	scriptedModel,
	serializeForProvider,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const host: { memo: string; note?: string; probe?: boolean } = { memo: "A" };
const injector = { on: false };

async function session() {
	let handle: EngineHandle | undefined;
	const stats = newStats();
	const factories: ExtensionFactory[] = [
		workExtension,
		(pi: ExtensionAPI) => {
			pi.registerTool({
				name: "probe",
				label: "probe",
				description: "A second tool, turned on and off by the host.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
			});
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections.memo = host.memo;
				if (host.note) event.systemPromptOptions.sections.note = host.note;
				// The "tools" scenario: the second tool is active only while the host says so (a tool change).
				const active = pi.getActiveTools();
				const want = host.probe ? [...new Set([...active, "probe"])] : active.filter((name) => name !== "probe");
				if (want.length !== active.length) pi.setActiveTools(want);
			});
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
		// Shared stats only: a reload loads the extensions afresh, as a real /reload does (see b03).
		(pi: ExtensionAPI) =>
			createContextEngine(
				{ stats },
				{
					onInstall: (installed: EngineHandle) => {
						handle = installed;
					},
				},
			)(pi),
	];
	const cwd = mkdtempSync(join(tmpdir(), "d23-"));
	let current = await createTestExtensionsResult(factories, cwd);
	const loader = {
		...createTestResourceLoader({ extensionsResult: current }),
		getExtensions: () => current,
		reload: async () => {
			current = await createTestExtensionsResult(factories, cwd);
		},
	};
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false, keepRecentTokens: 2_000 } },
		resourceLoader: loader,
	});
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	if (!handle) throw new Error("engine not installed");
	const model = scriptedModel(harness, 600);
	/** Per request: every system message as the provider receives it, in order, and the merged prompt text. */
	const systems: Array<{ bytes: string; merged: string; cuts: number }> = [];
	const wrap = () => {
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, options) => {
			const sys = (context.messages as Message[]).filter((x) => x.role === "system");
			const merged = getCurrentSystemMessage(context.messages as Message[]);
			systems.push({
				bytes: JSON.stringify(sys.map((x) => serializeForProvider(x))),
				merged: merged ? getSystemMessageText(merged) : "",
				cuts: stats.cuts.length,
			});
			return inner(m, context, options);
		};
	};
	wrap();
	return { harness, stats, model, systems, wrap, handle: () => handle as EngineHandle };
}

type S = Awaited<ReturnType<typeof session>>;

/** One run long enough to cut (20 tool turns of `size` tokens). */
async function run(s: S, task: string, seed: number, size = 6_000) {
	for (let t = 0; t < 20; t++) s.model.push(toolTurn(size, seed + t));
	s.model.push(finalTurn(`done ${seed}`));
	await s.harness.session.prompt(task);
}

/** Puts the scenario's section changes into effect at cuts; returns when the last change is in effect. */
async function scenario(s: S, name: string) {
	await run(s, "task 1: process the first batch.", 0);
	expect(s.stats.cuts.length, "the session cut").toBeGreaterThan(0);
	if (name === "one" || name === "two-cuts" || name === "mixed") {
		s.handle().setSectionAtNextCut("memo", "C");
		host.memo = "B"; // an older copy of the section, recorded in the run where the change happens
		if (name === "mixed") host.note = "N"; // recorded in the same system message, and not overridden
		await run(s, "task 2: process the next batch.", 100, 2_500);
		if (name === "two-cuts") {
			s.handle().setSectionAtNextCut("memo", "D");
			await run(s, "task 3: process another batch.", 200, 2_500);
			expect(s.handle().appliedSection("memo")).toBe("D");
		} else expect(s.handle().appliedSection("memo")).toBe("C");
	} else if (name === "superseded") {
		s.handle().setSectionAtNextCut("memo", "C");
		host.memo = "B";
		await run(s, "task 2: process the next batch.", 100, 2_500);
		expect(s.handle().appliedSection("memo")).toBe("C");
		// The host sets the section again after the cut: its newer text wins, and the next cut has no override.
		host.memo = "F";
		const cuts = s.stats.cuts.length;
		await run(s, "task 3: process another batch.", 200, 2_500);
		expect(s.stats.cuts.length, "a cut after the host's change").toBeGreaterThan(cuts);
		expect(s.handle().appliedSection("memo")).toBeUndefined();
	} else if (name === "new") {
		s.handle().setSectionAtNextCut("extra", "E");
		await run(s, "task 2: process the next batch.", 100, 2_500);
		expect(s.handle().appliedSection("extra")).toBe("E");
	} else if (name === "tools") {
		host.probe = true;
		const cuts = s.stats.cuts.length;
		await run(s, "task 2: process the next batch.", 100, 2_500);
		expect(s.stats.cuts.length, "a cut in the run that turned the tool on").toBeGreaterThan(cuts);
		host.probe = false;
	} else if (name === "pair") {
		s.handle().setSectionAtNextCut("memo", "C");
		s.handle().setSectionAtNextCut("extra", "E");
		await run(s, "task 2: process the next batch.", 100, 2_500);
		expect(s.handle().appliedSection("memo")).toBe("C");
		expect(s.handle().appliedSection("extra")).toBe("E");
	}
	// One short request after the change, so the "before" request is a plain in-session request, not a cut one.
	s.model.push(finalTurn("settled"));
	await s.harness.session.prompt("a short question.");
}

/** The rebuild paths. Each leaves the window as it was, apart from what the path itself changes, and adds no cut. */
const paths: Record<string, (s: S) => Promise<void>> = {
	reload: async (s) => {
		await reloadKeepingFaux(s.harness);
		s.wrap();
	},
	tree: async (s) => {
		// Navigate back to the last user message (its parent becomes the leaf): the engine's index no longer
		// matches the leaf and is rebuilt from the session.
		const branch = s.harness.sessionManager.getBranch();
		const lastUser = [...branch].reverse().find((e) => e.type === "message" && e.message.role === "user");
		if (!lastUser) throw new Error("no user message");
		await s.harness.session.navigateTree(lastUser.id);
	},
	edit: async (s) => {
		// A context edit on a tool result in the kept window (a replacement, which rebuilds the index).
		const branch = s.harness.sessionManager.getBranch();
		const result = [...branch].reverse().find((e) => e.type === "message" && e.message.role === "toolResult");
		if (!result) throw new Error("no tool result");
		s.harness.sessionManager.appendContextEdit(result.id, { content: "(edited)" });
	},
	align: async () => {
		injector.on = true;
	},
	delete: async (s) => {
		// A context edit that deletes a tool result in the kept window: the in-session splice path, not a rebuild.
		const branch = s.harness.sessionManager.getBranch();
		const result = [...branch].reverse().find((e) => e.type === "message" && e.message.role === "toolResult");
		if (!result) throw new Error("no tool result");
		s.harness.sessionManager.appendContextEdit(result.id, null);
	},
};

describe("D23: the system prompt after a rebuild without a cut is byte-identical to the in-session one", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		injector.on = false;
		host.memo = "A";
		host.note = undefined;
		host.probe = false;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const name of ["one", "two-cuts", "new", "pair", "mixed", "superseded", "tools"])
		for (const path of Object.keys(paths))
			it(`${name}, ${path}`, async () => {
				const s = await session();
				harnesses.push(s.harness);
				await scenario(s, name);
				const before = s.systems.at(-1)!;
				const cutsBefore = s.stats.cuts.length;
				const rebuildsBefore = s.stats.indexRebuilds;
				await paths[path](s);
				s.model.push(finalTurn("after"));
				await s.harness.session.prompt("another short question.");
				const after = s.systems.at(-1)!;
				expect(s.stats.cuts.length, "no cut between the two requests").toBe(cutsBefore);
				// The path really took the rebuild (or, for align, Pi's own messages): otherwise a pass would be empty.
				if (path !== "align" && path !== "delete")
					expect(s.stats.indexRebuilds, "the index was rebuilt").toBeGreaterThan(rebuildsBefore);
				// The delete path is the in-session splice, not a rebuild.
				if (path === "delete") expect(s.stats.indexRebuilds, "no rebuild for a deletion").toBe(rebuildsBefore);
				if (process.env.D23_SHOW) console.log(`${name}, ${path}\nBEFORE ${before.bytes}\nAFTER  ${after.bytes}`);
				expect(after.merged, "merged system prompt text").toBe(before.merged);
				expect(after.bytes, "system messages as the provider receives them").toBe(before.bytes);
			});
});
