import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { snapshotEngine } from "./snapshot-engine.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The engine PENpi ships: the module directory's entry file. */
export const ENGINE_FILE = resolve(HERE, "../../../../../.pi/extensions/penpi/engine/index.ts");
export const BASELINE_FILE =
	process.env.E2_BASELINE_FILE ?? resolve(HERE, "../context-engine/reference/r1-context-engine.ts");

/** The parts of the engine API the harness uses; every engine version has them. */
export interface EngineStatsLike {
	cuts: Array<{ seq: number; where: string; omitted: number; before: number; after: number }>;
	sent: Array<{ estimate: number; ratio: number; budget: number }>;
	overflowRetries: number;
	calibrationSamples: number[];
	plateaus?: Array<{ key: string; window: number }>;
	learnedWindows?: Array<{ key: string; window: number; source: string; confirmations?: number }>;
	probes?: Array<{ key: string; from: number; to: number }>;
	/** G2: the answers the engine named as produced from truncated input (ISO time of each answer). */
	plateauReports?: Array<{ key: string; window: number; turns: Array<{ at: string }> }>;
	providerErrors?: Array<{ class: string; rule: string }>;
	notices?: number;
	capDecisions?: number;
	capped?: number;
	imageEvictions?: number;
	alignMismatches?: number;
	lastLimits?: { window: number; budget: number; reason: string };
	/** The replay check's warnings (replayedReasoning disagreeing with the provider). */
	replayWarnings?: Array<{ key: string; setting: string; observed: string; median: number; pairs: number }>;
	replayChecks?: Record<string, { pairs: number; median: number }>;
	[key: string]: unknown;
}

export interface EngineUnderTest {
	label: string;
	/** The file the engine was read from. */
	source: string;
	/** The file actually imported. */
	loaded: string;
	sha256: string;
	via: string;
	createContextEngine: (options: Record<string, unknown>) => ExtensionFactory;
	newStats: () => EngineStatsLike;
	noticeMarker?: string;
	parseOverflow?: (text: string) => { limit?: number; requested?: number };
}

export async function loadEngine(): Promise<EngineUnderTest> {
	type Module = {
		createContextEngine: EngineUnderTest["createContextEngine"];
		newStats: EngineUnderTest["newStats"];
		NOTICE_MARKER?: string;
		parseOverflow?: EngineUnderTest["parseOverflow"];
	};
	const finish = (
		mod: Module,
		fields: Omit<EngineUnderTest, "createContextEngine" | "newStats" | "noticeMarker" | "parseOverflow">,
	) => {
		if (typeof mod.createContextEngine !== "function" || typeof mod.newStats !== "function")
			throw new Error(`E2: ${fields.loaded} does not export createContextEngine and newStats`);
		return {
			...fields,
			createContextEngine: mod.createContextEngine,
			newStats: mod.newStats,
			noticeMarker: mod.NOTICE_MARKER,
			parseOverflow: mod.parseOverflow,
		};
	};
	const explicit = process.env.E2_ENGINE;
	if (explicit || process.env.CONTEXT_ENGINE_BASELINE === "1") {
		const source = explicit ? resolve(explicit) : BASELINE_FILE;
		const { entry: path, sha, dir } = snapshotEngine(source);
		const mod = (await import(/* @vite-ignore */ path)) as Module;
		if (snapshotEngine(path).sha !== sha) throw new Error(`E2: ${path} changed while loading`);
		const original = existsSync(join(dir, "SOURCE")) ? readFileSync(join(dir, "SOURCE"), "utf8").trim() : source;
		return finish(mod, {
			label: process.env.E2_ENGINE_LABEL ?? (explicit ? `custom-${basename(source, ".ts")}` : "baseline"),
			source: process.env.E2_ENGINE_SOURCE ?? original,
			loaded: path,
			sha256: sha,
			via: explicit ? "E2_ENGINE (snapshot)" : "CONTEXT_ENGINE_BASELINE=1 (snapshot)",
		});
	}
	const file = ENGINE_FILE;
	const before = snapshotEngine(file).sha;
	const mod = (await import("../context-engine/engine.ts")) as unknown as Module;
	const after = snapshotEngine(file).sha;
	if (before !== after)
		throw new Error(
			`E2: ${file} or a file it imports changed while it was being loaded (${before} -> ${after}); retry`,
		);
	return finish(mod, {
		label: process.env.E2_ENGINE_LABEL ?? "revised",
		source: file,
		loaded: file,
		sha256: before,
		via: "context-engine/engine.ts",
	});
}
