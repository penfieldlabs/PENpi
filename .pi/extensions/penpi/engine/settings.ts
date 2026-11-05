/**
 * Engine options from the `penpi` block of the global Pi settings (ADR 0026: PENpi reads global settings
 * only), under the EngineOptions names. A value of the wrong type or out of range is ignored with a warning
 * and the default applies (ADR 0030: validate, do not coerce). Settings PENpi 0.4 used for FIFO are reported
 * as no longer used.
 */
import { DEFAULTS, type EngineOptions, type PinSource, type PinUserMessagesOptions } from "./options.ts";

/** Numeric settings: name, and the open-closed range a value must fall in. */
const NUMBERS: Array<[keyof EngineOptions, number, number]> = [
	["highWater", 0, 1],
	["lowWater", 0, 1],
	["outputReserveFraction", 0, 1],
	["maxUnitFraction", 0, 1],
	["implausibleOutputFraction", 0, 1],
	["defaultWindow", 0, Number.POSITIVE_INFINITY],
	["defaultMaxOutput", 0, Number.POSITIVE_INFINITY],
	["ratioFloor", 0, Number.POSITIVE_INFINITY],
	["ratioCeiling", 0, Number.POSITIVE_INFINITY],
	["silentShortfall", 0, 1],
	["silentMarginal", 0, 1],
	["silentStrongShortfall", 0, 1],
	["silentStrongGrowth", 0, Number.POSITIVE_INFINITY],
	["silentMinGrowth", 0, Number.POSITIVE_INFINITY],
	["silentZeroGrowthFloor", 0, Number.POSITIVE_INFINITY],
	["silentSuspects", 0, Number.POSITIVE_INFINITY],
	["silentEvidenceSpan", 0, Number.POSITIVE_INFINITY],
	["silentSettledSamples", 0, Number.POSITIVE_INFINITY],
	["silentReprobeBelow", 0, 1],
	["silentReprobes", -1, Number.POSITIVE_INFINITY],
	["plateauFlatness", 0, 1],
	["probeAfterParsed", 0, Number.POSITIVE_INFINITY],
	["probeAfterUnparsed", 0, Number.POSITIVE_INFINITY],
	["probeConfirmations", 0, Number.POSITIVE_INFINITY],
	["defaultImageTokens", 0, Number.POSITIVE_INFINITY],
	["imageShare", 0, 1],
	["noticeFraction", 0, 1],
	["searchMaxResults", 0, Number.POSITIVE_INFINITY],
	["searchMaxChars", 0, Number.POSITIVE_INFINITY],
	["maxOverflowRetries", -1, Number.POSITIVE_INFINITY],
	["maxLengthContinuations", -1, Number.POSITIVE_INFINITY],
	["maxOutputRetries", -1, Number.POSITIVE_INFINITY],
	["minOutputLimit", 0, Number.POSITIVE_INFINITY],
	["notesMaxChars", 0, Number.POSITIVE_INFINITY],
	["taskMaxChars", 0, Number.POSITIVE_INFINITY],
];
const BOOLEANS: Array<keyof EngineOptions> = ["calibrate", "notice", "noticeRepeats"];
const PIN_SOURCES: PinSource[] = ["interactive", "rpc", "extension"];
/** PENpi 0.4 FIFO settings: no longer read (0.5.0 replaced FIFO with the context engine). */
export const RETIRED_SETTINGS = ["contextFloor", "contextCeiling", "emergencyCompactionRuns"] as const;
/**
 * The `penpi` block's settings that are PENpi's own, not the engine's (config.ts, PenpiSettings). With the engine's
 * names they are every key the block may hold; any other key is reported (0.6.1), with the closest known name.
 */
export const PENPI_OWN_SETTINGS = [
	"penfield",
	"saveContextOnShutdown",
	"injectBriefing",
	"displayBriefing",
	"mcpLifecycle",
] as const;
/** The engine's settings besides NUMBERS and BOOLEANS. */
const ENGINE_OTHER_SETTINGS = [
	"windowCeiling",
	"limitOverrides",
	"modelLimits",
	"serializeAs",
	"replayedReasoning",
	"reasoningOnlyContinuation",
	"pinUserMessages",
	"faults",
	"production",
] as const;
/** Pairs whose first value must be below the second (0.6.1): each is checked alone, so the pair was not. */
const ORDERED_PAIRS: Array<[keyof EngineOptions, keyof EngineOptions, string]> = [
	["lowWater", "highWater", "below"],
	["ratioFloor", "ratioCeiling", "at most"],
];

/** Every key the `penpi` block may hold. */
export function knownSettings(): string[] {
	return [
		...NUMBERS.map(([name]) => name as string),
		...BOOLEANS.map((name) => name as string),
		...ENGINE_OTHER_SETTINGS,
		...PENPI_OWN_SETTINGS,
		...RETIRED_SETTINGS,
	];
}

/** Edit distance (insertions, deletions, substitutions, and a swap of two neighbours), case ignored. */
function distance(a: string, b: string): number {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array<number>(y.length).fill(0)]);
	for (let j = 1; j <= y.length; j++) d[0][j] = j;
	for (let i = 1; i <= x.length; i++)
		for (let j = 1; j <= y.length; j++) {
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1])
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	return d[x.length][y.length];
}

/** The known setting closest to `name`, when it is close enough to be a misspelling. */
export function closestSetting(name: string): string | undefined {
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const known of knownSettings()) {
		const dist = distance(name, known);
		if (dist < bestDistance) {
			best = known;
			bestDistance = dist;
		}
	}
	return best !== undefined && bestDistance <= Math.max(2, Math.floor(name.length / 4)) ? best : undefined;
}

/** Their environment variables, no longer read either. */
export const RETIRED_ENV = ["PENPI_CONTEXT_FLOOR", "PENPI_CONTEXT_CEILING", "PENPI_EMERGENCY_COMPACTION_RUNS"] as const;

/** A warning for each of PENpi 0.4's FIFO environment variables that is still set. */
export function retiredEnvWarnings(env: Record<string, string | undefined>, warn: (message: string) => void): void {
	for (const name of RETIRED_ENV)
		if (env[name] !== undefined)
			warn(
				`${name} is no longer used: PENpi 0.5.0 replaced FIFO with the context engine (see docs/CONTEXT_ENGINE.md); unset it`,
			);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `penpi.<name>` as the warning names it. */
const label = (name: string) => `penpi.${name}`;

function limitsMap(
	name: string,
	value: unknown,
	warn: (message: string) => void,
): Record<string, { contextWindow?: number; maxTokens?: number }> | undefined {
	if (!isRecord(value)) {
		warn(`ignoring ${label(name)}: not an object of "provider/model" entries`);
		return undefined;
	}
	const out: Record<string, { contextWindow?: number; maxTokens?: number }> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRecord(entry) || Object.keys(entry).some((k) => k !== "contextWindow" && k !== "maxTokens")) {
			warn(`ignoring ${label(name)}["${key}"]: only contextWindow and maxTokens are allowed`);
			continue;
		}
		const limits: { contextWindow?: number; maxTokens?: number } = {};
		for (const k of ["contextWindow", "maxTokens"] as const) {
			if (entry[k] === undefined) continue;
			if (isCount(entry[k]) && (entry[k] as number) > 0) limits[k] = entry[k] as number;
			else warn(`ignoring ${label(name)}["${key}"].${k}: not a positive number`);
		}
		out[key] = limits;
	}
	return out;
}

function stringMap<T extends string>(
	name: string,
	value: unknown,
	allowed: readonly T[] | undefined,
	warn: (message: string) => void,
): Record<string, T> | undefined {
	if (!isRecord(value)) {
		warn(`ignoring ${label(name)}: not an object`);
		return undefined;
	}
	const out: Record<string, T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" && (!allowed || allowed.includes(entry as T))) out[key] = entry as T;
		else
			warn(
				`ignoring ${label(name)}["${key}"]: ${allowed ? `must be one of ${allowed.join(", ")}` : "not a string"}`,
			);
	}
	return out;
}

function pinSettings(
	value: unknown,
	warn: (message: string) => void,
): Partial<PinUserMessagesOptions> | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) {
		warn(`ignoring ${label("pinUserMessages")}: null or an object`);
		return undefined;
	}
	const out: Partial<PinUserMessagesOptions> = {};
	const name = (k: string) => `pinUserMessages.${k}`;
	for (const [key, entry] of Object.entries(value)) {
		switch (key) {
			case "capFraction":
				if (typeof entry === "number" && entry >= 0 && entry <= 1) out.capFraction = entry;
				else warn(`ignoring ${label(name(key))}: a fraction from 0 to 1`);
				break;
			case "capMaxTokens":
			case "protectFirst":
			case "longMessageChars":
				if (isCount(entry)) out[key] = entry;
				else warn(`ignoring ${label(name(key))}: not a non-negative number`);
				break;
			case "sources":
				if (Array.isArray(entry) && entry.every((s) => PIN_SOURCES.includes(s as PinSource)))
					out.sources = entry as PinSource[];
				else warn(`ignoring ${label(name(key))}: a list of ${PIN_SOURCES.join(", ")}`);
				break;
			case "unrecordedSource":
				if (entry === "pin" || entry === "skip") out.unrecordedSource = entry;
				else warn(`ignoring ${label(name(key))}: "pin" or "skip"`);
				break;
			case "agentPrefixes":
				if (Array.isArray(entry) && entry.every((s) => typeof s === "string"))
					out.agentPrefixes = entry as string[];
				else warn(`ignoring ${label(name(key))}: a list of strings`);
				break;
			default:
				warn(`ignoring ${label(name(key))}: unknown pin setting`);
		}
	}
	return out;
}

/** Engine options from the `penpi` settings block; every problem is reported through `warn`. */
export function engineOptionsFromSettings(
	settings: Record<string, unknown> | undefined,
	warn: (message: string) => void,
): Partial<EngineOptions> {
	const s = settings ?? {};
	const out: Partial<EngineOptions> = {};
	for (const [name, min, max] of NUMBERS) {
		const v = s[name];
		if (v === undefined) continue;
		if (typeof v === "number" && Number.isFinite(v) && v > min && v <= max)
			(out as Record<string, unknown>)[name] = v;
		else
			warn(
				`ignoring ${label(name)}=${JSON.stringify(v)}: must be a number above ${min}${max < Infinity ? ` and at most ${max}` : ""}`,
			);
	}
	for (const name of BOOLEANS) {
		const v = s[name];
		if (v === undefined) continue;
		if (typeof v === "boolean") (out as Record<string, unknown>)[name] = v;
		else warn(`ignoring ${label(name)}=${JSON.stringify(v)}: not a boolean`);
	}
	if (s.windowCeiling !== undefined) {
		const v = s.windowCeiling;
		if (v === null || v === 0) out.windowCeiling = null;
		else if (isCount(v)) out.windowCeiling = v;
		else warn(`ignoring ${label("windowCeiling")}=${JSON.stringify(v)}: a number of tokens, or 0 or null to disable`);
	}
	for (const name of ["limitOverrides", "modelLimits"] as const) {
		if (s[name] === undefined) continue;
		const v = limitsMap(name, s[name], warn);
		if (v) out[name] = v;
	}
	if (s.serializeAs !== undefined) {
		const v = stringMap(
			"serializeAs",
			s.serializeAs,
			["openai-completions", "anthropic-messages", "bedrock-converse-stream"],
			warn,
		);
		if (v) out.serializeAs = v;
	}
	if (s.replayedReasoning !== undefined) {
		const v = stringMap("replayedReasoning", s.replayedReasoning, ["counted", "ignored"] as const, warn);
		if (v) out.replayedReasoning = v;
	}
	if (s.reasoningOnlyContinuation !== undefined) {
		const v = s.reasoningOnlyContinuation;
		if (v === "answer" || v === "continue") out.reasoningOnlyContinuation = v;
		else warn(`ignoring ${label("reasoningOnlyContinuation")}=${JSON.stringify(v)}: "answer" or "continue"`);
	}
	if (s.pinUserMessages !== undefined) {
		const v = pinSettings(s.pinUserMessages, warn);
		if (v !== undefined) out.pinUserMessages = v;
	}
	// Fault injection is a testing tool: only the environment turns it on (PENPI_FAULTS) or refuses it
	// (PENPI_PRODUCTION), so no settings file can switch it on for every session.
	if (s.faults !== undefined)
		warn(`ignoring ${label("faults")}: fault injection is turned on only with PENPI_FAULTS (a testing tool)`);
	if (s.production !== undefined)
		warn(`ignoring ${label("production")}: set PENPI_PRODUCTION=1 to refuse fault injection`);
	for (const name of RETIRED_SETTINGS) {
		if (s[name] !== undefined)
			warn(
				`${label(name)} is no longer used: PENpi 0.5.0 replaced FIFO with the context engine (see docs/CONTEXT_ENGINE.md); remove it from settings.json`,
			);
	}
	// 0.6.1: values valid alone can still contradict each other (the second reviewer: lowWater 0.9 with highWater
	// 0.5 gave 86 cuts instead of 8). An inconsistent pair falls back to the defaults, both values.
	const options = out as Record<string, number | undefined>;
	for (const [lower, upper, relation] of ORDERED_PAIRS) {
		if (options[lower] === undefined && options[upper] === undefined) continue;
		const low = options[lower] ?? (DEFAULTS[lower] as number);
		const high = options[upper] ?? (DEFAULTS[upper] as number);
		const ok = relation === "below" ? low < high : low <= high;
		if (ok) continue;
		warn(
			`ignoring ${label(lower)}=${low} and ${label(upper)}=${high}: ${lower} must be ${relation} ${upper}; using the defaults for both (${DEFAULTS[lower]} and ${DEFAULTS[upper]})`,
		);
		delete options[lower];
		delete options[upper];
	}
	// 0.6.1: a misspelled key was ignored without a word.
	const known = new Set(knownSettings());
	for (const key of Object.keys(s)) {
		if (known.has(key)) continue;
		const near = closestSetting(key);
		warn(`ignoring ${label(key)}: not a PENpi setting${near ? `; did you mean ${label(near)}?` : ""}`);
	}
	return out;
}
