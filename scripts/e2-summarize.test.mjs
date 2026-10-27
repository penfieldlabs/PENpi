// E2 summary gates that span a results directory (summarize.mjs): the replay check (review round 2, F5) and
// the per-run band-exempt note (Later 11). Runs are synthetic: only the fields the summary reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SUMMARIZE = fileURLToPath(
	new URL("../packages/coding-agent/test/suite/context-engine-e2/summarize.mjs", import.meta.url),
);

function run(id, { mode = "reasoning", misconfigured = false, warnings = [], named = null } = {}) {
	const criterion = (name) => ({ id: name, pass: true, value: "", threshold: "" });
	return {
		id,
		config: { id, mode, seed: 1, ...(misconfigured ? { replayMisconfigured: true } : {}) },
		engine: { label: "t", sha256: "0".repeat(64), source: "engine.ts", loaded: "engine.ts", via: "test" },
		tokenizer: "o200k",
		corpusFingerprint: "c",
		calls: 3,
		criteria: ["C1 rejections", "C2 largest", "C3 mean", "C4 breaks", "C5", "C6", "C7", "C8 named"].map(criterion),
		verdict: "PASS",
		rejections: { late: 0, allowance: 0, count: 0, at: [] },
		largest: { shareOfBudget: 0.7, shareOfHardLimit: 0.6, tokens: 700, budget: 1000, at: 2 },
		share: { mean: 0.6, minAfterFirstCut: 0.5 },
		prefix: { breaks: 0, breaksWithoutCut: [] },
		cuts: { at: [], count: 0 },
		silent: null,
		falseDetections: null,
		named,
		limits: { hardLimit: 1200, firstBudget: 1000, minBudget: 1000 },
		ratioTrace: {},
		series: { tokens: [500, 600, 700], budget: [1000, 1000, 1000], flags: ["", "", ""] },
		engineStats: warnings.length ? { replayWarnings: warnings } : {},
		runtimeMs: 1,
	};
}

function summarize(runs) {
	const dir = mkdtempSync(join(tmpdir(), "e2-summarize-"));
	try {
		for (const r of runs) writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r));
		const out = spawnSync(process.execPath, [SUMMARIZE, dir], { encoding: "utf8" });
		return { status: out.status, stderr: out.stderr, md: readFileSync(join(dir, "summary.md"), "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const WARNING = { key: "faux/e2-32k", setting: "ignored", observed: "counted", median: 0.97, pairs: 20 };

test("replay check: a warning in a run whose setting matches its provider fails the matrix", () => {
	const ok = summarize([run("a"), run("b")]);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.md, /No replay warning in any other run/);
	const bad = summarize([run("a"), run("b", { warnings: [WARNING] })]);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /replay check: 1 unexpected warning\(s\) \(b\)/);
	assert.match(bad.md, /\*\*FAIL\*\*: a replay warning in a run whose setting matches its provider: b/);
});

test("replay check: a misconfigured run must warn", () => {
	const ok = summarize([run("m1", { misconfigured: true, warnings: [WARNING] })]);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.md, /1 of 1 misconfigured runs .* warned\./);
	const bad = summarize([run("m1", { misconfigured: true }), run("m2", { misconfigured: true, warnings: [WARNING] })]);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /1 misconfigured run\(s\) without one \(m1\)/);
});

test("C8: a run whose truncations are mostly band-exempt gets its own note, even when the directory passes", () => {
	const named = (truncated, inBand) => ({
		at: [],
		truncated,
		visible: truncated - inBand.length,
		unnamed: [],
		unnamedInBand: inBand,
		inBandTokens: 40 * inBand.length,
		wronglyNamed: [],
		unmatched: 0,
	});
	const many = Array.from({ length: 30 }, (_, k) => run(`ok${k}`, { mode: "silent-messages", named: named(3, []) }));
	const out = summarize([...many, run("mostly", { mode: "silent-messages", named: named(5, [1, 2, 3, 4, 5]) })]);
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.md, /mostly: 5 of 5 truncated requests band-exempt \(200 tokens lost\)/);
	assert.doesNotMatch(out.md, /ok0: \d+ of \d+ truncated requests band-exempt/);
});

test("N2: misconfigured runs are reported in their own section and gated only on the warning", () => {
	const failing = (id, warnings) => {
		const r = run(id, { misconfigured: true, warnings });
		r.verdict = "FAIL";
		r.criteria = r.criteria.map((c) => (c.id.startsWith("C2") ? { ...c, pass: false } : c));
		r.largest.shareOfBudget = 1.12;
		r.rejections = { late: 2, allowance: 0, count: 3, at: [40, 41, 90] };
		r.engineStats = { ...r.engineStats, overflowRetries: 3, replayCheck: { "faux/e2-32k": { pairs: 31, median: 0.96 } } };
		return r;
	};
	const ok = summarize([run("normal"), failing("m1", [WARNING])]);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.md, /## Misconfigured runs/);
	assert.match(ok.md, /\| m1 \| FAIL \(C2 largest\) \| 2 \| 1\.12 \| 3 \| 3 \| 31 \| 0\.96 \| yes \|/);
	const bad = summarize([run("normal"), failing("m1", [])]);
	assert.equal(bad.status, 1);
	assert.match(bad.md, /\| m1 \| FAIL \(C2 largest\) \| 2 \| 1\.12 \| 3 \| 3 \| 31 \| 0\.96 \| \*\*no\*\* \|/);
});
