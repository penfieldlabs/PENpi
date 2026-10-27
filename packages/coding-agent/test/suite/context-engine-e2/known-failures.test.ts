/**
 * Known E2 failures (known-failures.ts): what an entry covers, and how summarize.mjs counts it. Runs in the
 * package's npm test (no tokenizers, no sessions): the summaries are built from made-up run results.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	type KnownFailureEntry,
	knownFailure,
	loadKnownFailures,
	penpiVersion,
	validateKnownFailures,
} from "./known-failures.ts";

const RUN = "research.glm.32k.silent-messages";
const summarize = fileURLToPath(new URL("./summarize.mjs", import.meta.url));
const version = penpiVersion();
/** A version after the current one, so the "known" cases do not depend on the repository's version. */
const later = version.replace(/\d+$/, (p) => String(Number(p) + 1));
const entry = (over: Partial<KnownFailureEntry> = {}): KnownFailureEntry => ({
	run: RUN,
	criterion: "C6 detection-lag",
	maxLag: 4,
	until: later,
	reason: "test entry",
	...over,
});

const CRITERIA = [
	"C1 rejections",
	"C2 largest",
	"C3 mean-after-cut",
	"C4 breaks==cuts",
	"C5 truncated",
	"C6 detection-lag",
	"C7 false-detections",
	"C8 named",
];

/** A run result with the fields summarize.mjs reads; `failing` lists the criteria (by number) that fail. */
function run(id: string, { failing = [] as string[], lag = 1 as number | null, detected = [5] } = {}) {
	return {
		id,
		config: { id, seed: 1 },
		engine: { label: "test", sha256: "0".repeat(64), source: "test", via: "test" },
		tokenizer: "test",
		corpusFingerprint: "test",
		calls: 30,
		limits: { hardLimit: 16384, firstBudget: 26215, minBudget: 26215 },
		rejections: { count: 0, late: 0, at: [], allowance: 0 },
		largest: { tokens: 1000, at: 3, budget: 2000, shareOfBudget: 0.5, shareOfHardLimit: 0.06 },
		share: { mean: 0.5, minAfterFirstCut: 0.4 },
		ratioTrace: {},
		cuts: { at: [], count: 0 },
		prefix: { breaks: 0, breaksWithoutCut: [] },
		series: { tokens: [], budget: [], flags: [] },
		silent: {
			truncated: 4,
			at: [1, 2, 3, 4],
			truncatedTokens: 100,
			engineDetectedAt: detected,
			lagToDetection: lag,
			lastTruncated: 4,
		},
		falseDetections: { count: 0, at: [] },
		criteria: CRITERIA.map((c) => ({ id: c, pass: !failing.includes(c.split(" ")[0]), value: "", threshold: "" })),
		verdict: failing.length ? "FAIL" : "PASS",
		runtimeMs: 1,
	};
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** summarize.mjs on these runs with these entries: its exit code and summary.md. */
function summary(runs: ReturnType<typeof run>[], entries: unknown, expectRuns = 0, defaultMatrix = false) {
	const dir = mkdtempSync(join(tmpdir(), "e2-known-"));
	dirs.push(dir);
	const results = join(dir, "results");
	mkdirSync(results);
	for (const r of runs) writeFileSync(join(results, `${r.id}.json`), JSON.stringify(r));
	writeFileSync(join(dir, "known.json"), JSON.stringify(entries));
	const env = {
		...process.env,
		E2_KNOWN_FAILURES: join(dir, "known.json"),
		E2_EXPECT_RUNS: String(expectRuns),
		E2_DEFAULT_MATRIX: defaultMatrix ? "1" : "0",
	};
	const p = spawnSync(process.execPath, [summarize, results], { env, encoding: "utf8" });
	return { code: p.status, md: readFileSync(join(results, "summary.md"), "utf8") };
}

describe("E2 known failures", () => {
	it("the repository's entries are valid", () => {
		expect(validateKnownFailures(loadKnownFailures())).toEqual([]);
	});

	it("covers its run failing C6 alone within the bound, below its version", () => {
		expect(knownFailure(run(RUN, { failing: ["C6"], lag: 4 }), [entry()], version)?.status).toBe("known");
		const s = summary([run(RUN, { failing: ["C6"], lag: 4 }), run("other.run")], [entry()]);
		expect(s.code).toBe(0);
		expect(s.md).toContain(`- runs: 2, PASS 1, FAIL 0, KNOWN 1 (${RUN} C6 lag 4, until ${later})`);
		expect(s.md).toContain("occurred, lag 4; counted as KNOWN");
	});

	it("does not cover a longer lag, a run that never detected, or a second failing criterion", () => {
		for (const r of [
			run(RUN, { failing: ["C6"], lag: 5 }),
			run(RUN, { failing: ["C6"], lag: null, detected: [] }),
			run(RUN, { failing: ["C5", "C6"], lag: 4 }),
		]) {
			expect(knownFailure(r, [entry()], version)).toBeNull();
			const s = summary([r], [entry()]);
			expect(s.code).toBe(1);
			expect(s.md).toContain("FAIL 1;");
		}
	});

	it("does not cover another run with the same failure", () => {
		const other = run("research.glm.128k.silent-messages", { failing: ["C6"], lag: 4 });
		expect(knownFailure(other, [entry()], version)).toBeNull();
		expect(summary([other], [entry()]).code).toBe(1);
	});

	it("an entry at or past its version is expired and fails", () => {
		const r = run(RUN, { failing: ["C6"], lag: 4 });
		expect(knownFailure(r, [entry({ until: version })], version)?.status).toBe("expired");
		const s = summary([r], [entry({ until: version })]);
		expect(s.code).toBe(1);
		expect(s.md).toContain("**EXPIRED**");
	});

	it("a run that passes is reported, not failed", () => {
		const s = summary([run(RUN)], [entry()]);
		expect(s.code).toBe(0);
		expect(s.md).toContain("did not occur (the run passed): remove the entry");
	});

	it("an entry for a run the full matrix does not have fails; an invalid entry excuses nothing", () => {
		expect(summary([run("other.run")], [entry({ run: "no.such.run" })], 1, true).code).toBe(1);
		expect(summary([run("other.run")], [entry({ run: "no.such.run" })]).md).toContain("not run in this directory");
		const bad = summary([run(RUN, { failing: ["C6"], lag: 4 })], [entry({ criterion: "C5 truncated" })]);
		expect(bad.code).toBe(1);
		expect(bad.md).toContain("FAIL 1;");
		expect(validateKnownFailures([{ run: RUN }])).toHaveLength(4);
	});

	it("a complete set that is not the default matrix (the misconfigured runs, a selection) reports the entry as not run", () => {
		// The release gate's 8 misconfigured runs: every run present, the entry's run not among them.
		const misconfigured = ["coding", "research", "cjk", "data"].flatMap((mix) =>
			["glm", "o200k"].map((tok) => {
				const id = `${mix}.${tok}.128k.reasoning-high-misconfigured`;
				const r = run(id);
				return {
					...r,
					config: { ...r.config, replayMisconfigured: true },
					engineStats: { replayWarnings: ["replayed reasoning is counted by the provider"] },
				};
			}),
		);
		const s = summary(misconfigured, [entry()], 8);
		expect(s.code).toBe(0);
		expect(s.md).toContain(
			`- ${RUN}, C6 detection-lag (lag at most 4, until PENpi ${later}): not run in this directory`,
		);
		// A complete selection of two default-matrix runs without the entry's run.
		const selection = [run("coding.glm.32k.silent-messages"), run("coding.glm.32k.reasoning-minimal")];
		expect(summary(selection, [entry()], 2).code).toBe(0);
		// The same runs as the default matrix: the entry's run is missing there, which fails.
		expect(summary(selection, [entry()], 2, true).code).toBe(1);
	});
});
