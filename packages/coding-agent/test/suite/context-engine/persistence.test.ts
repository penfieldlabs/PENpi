/**
 * Cut and calibration survive /reload (fresh extension instance), resume (reopened session file) and
 * fork (copied session file). Manual /compact and /tree summaries never call the model.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, type EngineMode, NOTICE_MARKER, newStats } from "./engine.ts";
import {
	analyzePrefixes,
	finalTurn,
	LOG_DIR,
	logger,
	reloadKeepingFaux,
	rng,
	type ScriptedModel,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const results: Record<string, Record<string, unknown>> = {};

/** A resource loader whose reload() re-runs the factories, like a real /reload. */
async function reloadingLoader(factories: ExtensionFactory[], cwd: string) {
	let current = await createTestExtensionsResult(factories, cwd);
	const base = createTestResourceLoader({ extensionsResult: current });
	return {
		...base,
		getExtensions: () => current,
		reload: async () => {
			current = await createTestExtensionsResult(factories, cwd);
		},
	};
}

async function open(
	mode: EngineMode,
	sessionManager: SessionManager,
	label: string,
	keepRecentTokens?: number,
	stats = newStats(),
) {
	const log = logger(`persistence.${mode}.log`);
	const factories: ExtensionFactory[] = [
		workExtension,
		createContextEngine({ mode, stats, log: (l) => log(`${label} ${l}`) }),
	];
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false, ...(keepRecentTokens === undefined ? {} : { keepRecentTokens }) } },
		sessionManager,
		resourceLoader: await reloadingLoader(factories, sessionManager.getCwd()),
	});
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	return { harness, model: scriptedModel(harness), stats };
}

async function work(model: ScriptedModel, harness: Harness, prompts: number, seedBase: number) {
	const next = rng(seedBase);
	for (let p = 0; p < prompts; p++) {
		for (let t = 0; t < 19; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), seedBase + p * 100 + t));
		model.push(finalTurn(`done ${seedBase}-${p}`));
		await harness.session.prompt(`Task ${seedBase}-${p}`);
	}
}

/** Whether `after` extends `before` message for message (the cached prefix survives); the request-only notice is ignored. */
function extendsPrefix(before: string[], after: string[]): boolean {
	return (
		analyzePrefixes([before, after], (m) => NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER)).breaks === 0
	);
}

/** The window number in a request's header (0 before the first cut). A lost cut would restart lower. */
function windowSeq(request: string[]): number {
	return Math.max(
		0,
		...request.flatMap((m) => [...m.matchAll(/\[context window #(\d+)\]/g)].map((x) => Number(x[1]))),
	);
}

describe("context engine: persistence", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/persistence.json`, JSON.stringify(results, null, 2));
	});

	for (const [mode, keepRecent] of [
		// Port: mode a only (the prototype's comparison modes are not ported).
		["a", undefined],
	] as const) {
		it(`mode ${mode} (keepRecentTokens ${keepRecent ?? "default"}): reload, resume and fork keep the cut and the calibration`, async () => {
			const report: Record<string, unknown> = {};
			results[`${mode}.keepRecent=${keepRecent ?? "default"}`] = report;
			const dir = mkdtempSync(join(tmpdir(), "ce-persist-"));
			const first = await open(mode, SessionManager.create(dir, dir), "first", keepRecent);
			harnesses.push(first.harness);
			await work(first.model, first.harness, 3, 1);
			const file = first.harness.sessionManager.getSessionFile();
			const beforeReload = first.model.requests.at(-1) ?? [];
			const cutsBeforeReload = first.stats.cuts.length;

			await reloadKeepingFaux(first.harness);
			first.model.push(finalTurn("after reload"));
			await first.harness.session.prompt("after reload");
			const afterReload = first.model.requests.at(-1) ?? [];
			report.reload = {
				cutsBefore: cutsBeforeReload,
				newCuts: first.stats.cuts.length - cutsBeforeReload,
				prefixKept: extendsPrefix(beforeReload, afterReload),
				seq: [windowSeq(beforeReload), windowSeq(afterReload)],
			};

			// Resume: a new process opens the same file.
			const lastBeforeResume = afterReload;
			const resumed = await open(mode, SessionManager.open(file!), "resume", keepRecent);
			harnesses.push(resumed.harness);
			resumed.model.push(finalTurn("after resume"));
			await resumed.harness.session.prompt("after resume");
			const afterResume = resumed.model.requests.at(-1) ?? [];
			report.resume = {
				prefixKept: extendsPrefix(lastBeforeResume, afterResume),
				seq: [windowSeq(lastBeforeResume), windowSeq(afterResume)],
				newCuts: resumed.stats.cuts.length,
				firstRatio: resumed.stats.sent[0]?.ratio,
				lastRatioBefore: first.stats.sent.at(-1)?.ratio,
			};

			// Fork: a copy of the session file.
			const forked = await open(
				mode,
				SessionManager.forkFrom(resumed.harness.sessionManager.getSessionFile()!, dir, dir),
				"fork",
				keepRecent,
			);
			harnesses.push(forked.harness);
			forked.model.push(finalTurn("after fork"));
			await forked.harness.session.prompt("after fork");
			report.fork = {
				prefixKept: extendsPrefix(afterResume, forked.model.requests.at(-1) ?? []),
				seq: [windowSeq(afterResume), windowSeq(forked.model.requests.at(-1) ?? [])],
				newCuts: forked.stats.cuts.length,
				firstRatio: forked.stats.sent[0]?.ratio,
			};

			// Manual /compact: advances the window, no model call.
			const callsBefore = forked.harness.faux.state.callCount;
			let compactOutcome: string;
			try {
				const result = await forked.harness.session.compact();
				compactOutcome = `compaction entry: ${result.summary.slice(0, 40)}`;
			} catch (error) {
				compactOutcome = `threw: ${(error as Error).message}`;
			}
			forked.model.push(finalTurn("after compact"));
			await forked.harness.session.prompt("after compact");
			report.manualCompact = {
				outcome: compactOutcome,
				modelCallsDuringCompact: forked.harness.faux.state.callCount - callsBefore - 1,
				cutsAfter: forked.stats.cuts.map((c) => c.where),
				compactionEnd: forked.harness
					.eventsOfType("compaction_end")
					.map((e) => ({ aborted: e.aborted, error: e.errorMessage })),
			};

			// /tree with a summary: fixed notice, no model call.
			const target = forked.harness.sessionManager
				.getBranch()
				.filter((e) => e.type === "message" && e.message.role === "user")
				.at(-3);
			const callsBeforeTree = forked.harness.faux.state.callCount;
			const navigation = await forked.harness.session.navigateTree(target!.id, { summarize: true });
			report.tree = {
				cancelled: navigation.cancelled,
				summary: navigation.summaryEntry?.summary.slice(0, 80),
				modelCalls: forked.harness.faux.state.callCount - callsBeforeTree,
			};

			expect(cutsBeforeReload).toBeGreaterThan(0);
			// The cut survives each step: the window number never goes back, and without a new cut the
			// prefix is kept. A step may legitimately cut once if its prompt crosses high water.
			for (const step of ["reload", "resume", "fork"] as const) {
				const r = report[step] as { newCuts: number; prefixKept: boolean; seq: [number, number] };
				expect(r.seq[0]).toBeGreaterThan(0);
				expect(r.seq[1]).toBeGreaterThanOrEqual(r.seq[0]);
				expect(r.seq[1]).toBeLessThanOrEqual(r.seq[0] + r.newCuts);
				if (r.newCuts === 0) expect(r.prefixKept).toBe(true);
			}
			const resume = report.resume as { firstRatio: number; lastRatioBefore: number };
			expect(Math.abs(resume.firstRatio - resume.lastRatioBefore) / resume.lastRatioBefore).toBeLessThan(0.05);
			expect(report.manualCompact).toMatchObject({ modelCallsDuringCompact: 0 });
			expect(report.tree).toMatchObject({ modelCalls: 0 });
		});
	}
});
