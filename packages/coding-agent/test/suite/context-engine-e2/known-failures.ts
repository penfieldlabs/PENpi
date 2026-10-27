/**
 * Known E2 failures: a run that fails one named criterion within a recorded bound, accepted by decision until a
 * PENpi version (known-failures.json). Read by suite.ts (the run's test) and summarize.mjs (the counts and the exit
 * code). An entry excuses exactly its run and its criterion, within its bound, below its `until` version; anything
 * else fails as before. The criteria themselves (metrics.ts) do not change: the run's own result still says FAIL.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface KnownFailureEntry {
	run: string;
	criterion: string;
	maxLag: number;
	until: string;
	reason: string;
}

export type KnownFailureStatus = "known" | "expired";

interface RunLike {
	id: string;
	criteria: { id: string; pass: boolean | null }[];
	silent?: { lagToDetection: number | null; engineDetectedAt: number[] } | null;
}

/** The only criterion an entry can name: its bound is the detection lag. */
const SUPPORTED = "C6 detection-lag";
const VERSION = /^\d+\.\d+\.\d+$/;

/** E2_KNOWN_FAILURES names another file (the unit test uses it); the default is the one next to this module. */
export function knownFailuresFile(): string {
	return process.env.E2_KNOWN_FAILURES ?? fileURLToPath(new URL("./known-failures.json", import.meta.url));
}

export function loadKnownFailures(file = knownFailuresFile()): KnownFailureEntry[] {
	return JSON.parse(readFileSync(file, "utf8")) as KnownFailureEntry[];
}

/** PENpi's version, from the repository's root package.json. */
export function penpiVersion(): string {
	const file = fileURLToPath(new URL("../../../../../package.json", import.meta.url));
	return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/** Problems with the entries themselves; any one fails the summary, so a typo cannot excuse nothing silently. */
export function validateKnownFailures(entries: unknown): string[] {
	if (!Array.isArray(entries)) return ["known failures: not a list"];
	const problems: string[] = [];
	entries.forEach((e: Partial<KnownFailureEntry>, i) => {
		const where = `known failure ${i + 1}${typeof e?.run === "string" ? ` (${e.run})` : ""}`;
		if (typeof e?.run !== "string" || !e.run) problems.push(`${where}: no run id`);
		if (e?.criterion !== SUPPORTED) problems.push(`${where}: criterion must be "${SUPPORTED}"`);
		if (!Number.isInteger(e?.maxLag) || (e.maxLag as number) < 0)
			problems.push(`${where}: maxLag must be a whole number`);
		if (typeof e?.until !== "string" || !VERSION.test(e.until))
			problems.push(`${where}: until must be a version x.y.z`);
		if (typeof e?.reason !== "string" || !e.reason.trim()) problems.push(`${where}: no reason`);
	});
	return problems;
}

function compareVersions(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
	return 0;
}

/**
 * The entry that covers this run's failure, if any. It covers it only when the run id matches, the named criterion
 * is the run's only failing one, the engine detected at all and the lag is at most maxLag. "known": below `until`;
 * "expired": at or past it, which fails like any other failure.
 */
export function knownFailure(
	run: RunLike,
	entries: KnownFailureEntry[],
	version: string,
): { entry: KnownFailureEntry; status: KnownFailureStatus } | null {
	const failing = run.criteria.filter((c) => c.pass === false).map((c) => c.id);
	for (const entry of entries) {
		if (entry.run !== run.id || failing.length !== 1 || failing[0] !== entry.criterion) continue;
		const lag = run.silent?.lagToDetection;
		if (!run.silent?.engineDetectedAt?.length || typeof lag !== "number" || lag > entry.maxLag) continue;
		return { entry, status: compareVersions(version, entry.until) < 0 ? "known" : "expired" };
	}
	return null;
}
