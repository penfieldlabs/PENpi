#!/usr/bin/env node
/**
 * E2 summary. Usage: node summarize.mjs <results-dir> [<results-dir> ...]
 * Reads every <run>.json in each directory, writes <dir>/summary.json and <dir>/summary.md, prints the
 * PASS/FAIL table, and (with two or more directories) a side-by-side comparison to stdout and to
 * $E2_COMPARE_OUT if set. Exit code 1 if any run FAILs, if a directory has no runs, or if fewer runs
 * than $E2_EXPECT_RUNS are found. A run covered by an entry of known-failures.json is counted as KNOWN, not FAIL,
 * until the entry's version; an expired or invalid entry fails the summary.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { knownFailure, loadKnownFailures, penpiVersion, validateKnownFailures } from "./known-failures.ts";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
	console.error("usage: node summarize.mjs <results-dir> [<results-dir> ...]");
	process.exit(2);
}

// Known failures (known-failures.ts), read once. A problem with the entries excuses nothing and fails the summary.
let knownEntries = [];
const knownProblems = [];
try {
	knownEntries = loadKnownFailures();
	knownProblems.push(...validateKnownFailures(knownEntries));
} catch (e) {
	knownProblems.push(`known failures: ${e.message}`);
}
const penpi = penpiVersion();
const knownOf = (m) => (knownProblems.length || m.config.replayMisconfigured ? null : knownFailure(m, knownEntries, penpi));
const isKnown = (m) => knownOf(m)?.status === "known";

/** One line per entry: whether its failure occurred in this directory; `fail` when an entry needs attention. */
function knownReport(runs, fullMatrix) {
	if (knownProblems.length) return { lines: knownProblems.map((p) => `- **FAIL**: ${p}`), fail: true };
	if (knownEntries.length === 0) return { lines: ["None."], fail: false };
	let fail = false;
	const lines = knownEntries.map((entry) => {
		const head = `- ${entry.run}, ${entry.criterion} (lag at most ${entry.maxLag}, until PENpi ${entry.until}): `;
		const m = runs.find((r) => r.id === entry.run);
		if (!m) {
			if (fullMatrix) fail = true;
			return `${head}${fullMatrix ? "**FAIL**: no such run in the full matrix (check the run id)" : "not run in this directory"}. ${entry.reason}`;
		}
		const k = knownFailure(m, [entry], penpi);
		const lag = m.silent?.lagToDetection ?? "undetected";
		if (k?.status === "known") return `${head}occurred, lag ${lag}; counted as KNOWN. ${entry.reason}`;
		if (k?.status === "expired")
			return `${head}**EXPIRED** at PENpi ${penpi} (lag ${lag}); counted as FAIL: remove the entry, or renew it by decision. ${entry.reason}`;
		if (m.verdict === "PASS") return `${head}did not occur (the run passed): remove the entry. ${entry.reason}`;
		const failing = m.criteria.filter((c) => c.pass === false).map((c) => c.id);
		return `${head}does not cover this failure (failing: ${failing.join(", ")}; lag ${lag}); counted as FAIL. ${entry.reason}`;
	});
	return { lines, fail };
}

const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "-" : Number(x).toFixed(d));
const mark = (c) =>
	!c ? "-" : c.pass === null ? "n/a" : c.pass ? (c.note?.startsWith("vacuous") ? "vacuous" : "ok") : "**FAIL**";

function load(dir) {
	const engine = existsSync(join(dir, "engine.json")) ? JSON.parse(readFileSync(join(dir, "engine.json"), "utf8")) : {};
	const runs = readdirSync(dir)
		.filter((f) => f.endsWith(".json") && !["engine.json", "summary.json", "selftest.json"].includes(f) && !f.startsWith("selftest"))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
		.filter((m) => m.criteria && m.config)
		.sort((a, b) => a.id.localeCompare(b.id));
	return { dir, engine, runs };
}

function worst(runs) {
	const by = (key, dir = -1) => [...runs].sort((a, b) => dir * (key(a) - key(b)))[0];
	const out = [];
	const maxRun = by((m) => m.largest.shareOfBudget);
	if (maxRun) out.push(`largest request: ${maxRun.id} ${maxRun.largest.tokens} tok = ${maxRun.largest.shareOfBudget} x budget ${maxRun.largest.budget} at call ${maxRun.largest.at}`);
	const meanRun = by((m) => meanAfterFirstCut(m) ?? m.share.mean, 1);
	if (meanRun) out.push(`lowest mean after the first cut: ${meanRun.id} ${fmt(meanAfterFirstCut(meanRun) ?? meanRun.share.mean, 3)} x budget`);
	const rej = by((m) => m.rejections.late);
	if (rej?.rejections.late) out.push(`most late rejections: ${rej.id} ${rej.rejections.late} (at ${rej.rejections.at.slice(0, 10).join(",")})`);
	const trunc = by((m) => m.silent?.truncated ?? -1);
	if (trunc?.silent?.truncated) out.push(`most truncated requests: ${trunc.id} ${trunc.silent.truncated} (engine detected at ${trunc.silent.engineDetectedAt.join(",") || "never"})`);
	const lagRun = by((m) => (m.silent ? (m.silent.lagToDetection ?? m.silent.truncated) : -1));
	if (lagRun?.silent?.truncated) out.push(`longest detection lag: ${lagRun.id} ${lagRun.silent.lagToDetection ?? `${lagRun.silent.truncated} (never detected)`}`);
	const falseRuns = runs.filter((m) => m.falseDetections?.count > 0);
	if (falseRuns.length) out.push(`false detections: ${falseRuns.map((m) => `${m.id} (${m.falseDetections.at.join(",")})`).join(", ")}`);
	const unexplained = runs.filter((m) => m.prefix.breaksWithoutCut.length > 0);
	if (unexplained.length) out.push(`prefix breaks without a cut: ${unexplained.map((m) => `${m.id} (${m.prefix.breaksWithoutCut.length})`).join(", ")}`);
	return out;
}

function ratioDeviation(m) {
	const trace = Object.values(m.ratioTrace)[0] ?? [];
	const devs = trace.filter((t) => t.call > 0 && Number.isFinite(t.engineRatio) && Number.isFinite(t.trueRatio)).map((t) => t.engineRatio / t.trueRatio - 1);
	if (devs.length === 0) return "-";
	return `${fmt(Math.min(...devs) * 100, 0)}..${fmt(Math.max(...devs) * 100, 0)}%`;
}

/** Mean request / budget over accepted requests after the first cut (ramp-up excluded), from the series. */
function meanAfterFirstCut(m) {
	const first = m.cuts.at[0];
	if (first === undefined) return null;
	const { tokens, budget, flags } = m.series;
	const shares = tokens.flatMap((t, i) => (i > first && !flags[i].includes("R") ? [t / budget[i]] : []));
	return shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
}

/** C3 values across runs: the floor is a gate, the distribution is reported so a drift shows before it fails. */
function c3Trend(runs) {
	const values = runs.map((m) => meanAfterFirstCut(m) ?? m.share.mean).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	const q = (p) => (values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : null);
	const threshold = runs[0]?.criteria.find((c) => c.id.startsWith("C3"))?.threshold ?? "";
	const floor = Number(threshold.match(/[\d.]+/)?.[0] ?? Number.NaN);
	const round3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
	return {
		floor: Number.isFinite(floor) ? floor : null,
		runs: values.length,
		min: round3(values[0] ?? null),
		p10: round3(q(0.1)),
		median: round3(q(0.5)),
		mean: round3(values.length ? values.reduce((a, b) => a + b, 0) / values.length : null),
		belowHalf: values.filter((v) => v < 0.5).length,
	};
}

/**
 * C8 false-name ceiling, across the silent runs of a results directory: answers named without truncation, over
 * all named answers. C8 itself fails a run only for a missed name; without a ceiling an engine that named every
 * recent answer would pass. Applied from FALSE_NAME_MIN_NAMES names on, so a one-run subset with one wrong name
 * in three does not fail on noise.
 */
const FALSE_NAME_CEILING = 0.05;
const FALSE_NAME_MIN_NAMES = 20;
/**
 * C8 band-exempt ceiling: truncations inside the band that were not named, over all truncated requests of the
 * silent runs. Above it the band is excusing too much; applied from BAND_EXEMPT_MIN_TRUNCATED truncations on.
 */
const BAND_EXEMPT_CEILING = 0.1;
const BAND_EXEMPT_MIN_TRUNCATED = 20;

/** C8 across the silent runs: what was named, what was missed outside and inside the band, and wrong names. */
function c8Report(runs) {
	const rows = runs.filter((m) => m.named);
	const sum = (f) => rows.reduce((s, m) => s + f(m.named), 0);
	const totals = {
		runs: rows.length,
		truncated: sum((n) => n.truncated),
		visible: sum((n) => n.visible),
		named: sum((n) => n.at.length),
		unnamed: sum((n) => n.unnamed.length),
		unnamedInBand: sum((n) => n.unnamedInBand.length),
		// Results written before the band cap have no inBandTokens: unknown, not zero.
		inBandTokens: rows.every((m) => typeof m.named.inBandTokens === "number") ? sum((n) => n.inBandTokens) : null,
		wronglyNamed: sum((n) => n.wronglyNamed.length),
		runsWithWrongNames: rows.filter((m) => m.named.wronglyNamed.length > 0).length,
	};
	totals.falseNameRate = totals.named ? totals.wronglyNamed / totals.named : 0;
	totals.falseNamesFail = totals.named >= FALSE_NAME_MIN_NAMES && totals.falseNameRate > FALSE_NAME_CEILING;
	totals.bandExemptShare = totals.truncated ? totals.unnamedInBand / totals.truncated : 0;
	totals.bandExemptFail = totals.truncated >= BAND_EXEMPT_MIN_TRUNCATED && totals.bandExemptShare > BAND_EXEMPT_CEILING;
	// Later 11: the ceiling is pooled, so one run whose truncations are mostly band-exempt can pass inside a
	// directory with many truncations; such runs are named (reported, not failed).
	const mostlyExempt = rows
		.filter((m) => m.named.truncated >= 2 && m.named.unnamedInBand.length > m.named.truncated / 2)
		.map(
			(m) =>
				`${m.id}: ${m.named.unnamedInBand.length} of ${m.named.truncated} truncated requests band-exempt${typeof m.named.inBandTokens === "number" ? ` (${m.named.inBandTokens} tokens lost)` : ""}`,
		);
	const listed = rows.filter((m) => m.named.unnamed.length || m.named.unnamedInBand.length || m.named.wronglyNamed.length);
	const lines = listed.map(
		(m) =>
			`| ${m.id} | ${m.named.truncated} | ${m.named.visible} | ${m.named.at.length} | ${m.named.unnamed.join(",") || "-"} | ${m.named.unnamedInBand.join(",") || "-"} | ${m.named.wronglyNamed.join(",") || "-"} |`,
	);
	return { totals, lines, mostlyExempt };
}

/**
 * The replay check across a results directory: a run configured against its provider
 * (E2_REASONING_COUNT=misconfigured) must have warned; any other run must not have. Either failure fails the
 * matrix.
 */
function replayReport(runs) {
	const warned = (m) => (m.engineStats?.replayWarnings?.length ?? 0) > 0;
	const misconfigured = runs.filter((m) => m.config.replayMisconfigured);
	return {
		misconfigured: misconfigured.length,
		warned: misconfigured.filter(warned).length,
		unexpected: runs.filter((m) => !m.config.replayMisconfigured && warned(m)).map((m) => m.id),
		missing: misconfigured.filter((m) => !warned(m)).map((m) => m.id),
	};
}

function table(runs) {
	const head =
		"| run | verdict | C1 late rej / allowed (total; first calls) | C2 max/budget (max/limit) | C3 mean after 1st cut (whole; min after cut) | C4 breaks/cut requests | C5 truncated | C6 lag (engine detected at) | C7 false detections | ratio err | hard limit | budget | calls | s |";
	const sep = `|${head
		.split("|")
		.slice(1, -1)
		.map(() => "---")
		.join("|")}|`;
	const rows = runs.map((m) => {
		const c = Object.fromEntries(m.criteria.map((x) => [x.id.split(" ")[0], x]));
		const r = m.rejections;
		const rej = `${mark(c.C1)} ${r.late}/${r.allowance ?? 0} (${r.count}${r.count ? `; ${r.at.slice(0, 4).join(",")}${r.count > 4 ? ",..." : ""}` : ""})`;
		const lag = m.silent
			? `${mark(c.C6)} ${m.silent.lagToDetection ?? `${m.silent.truncated}, undetected`} (${m.silent.engineDetectedAt.join(",") || "never"})`
			: "n/a";
		const fd = m.falseDetections ? `${mark(c.C7)} ${m.falseDetections.count}` : "n/a";
		return `| ${m.id} | ${m.verdict === "PASS" ? "PASS" : isKnown(m) ? "KNOWN" : "**FAIL**"} | ${rej} | ${mark(c.C2)} ${fmt(m.largest.shareOfBudget)} (${fmt(m.largest.shareOfHardLimit)}) | ${mark(c.C3)} ${fmt(meanAfterFirstCut(m) ?? m.share.mean)} (${fmt(m.share.mean)}; ${fmt(m.share.minAfterFirstCut)}) | ${mark(c.C4)} ${m.prefix.breaks}/${m.cuts.at.length} | ${m.silent ? `${mark(c.C5)} ${m.silent.truncated}` : "n/a"} | ${lag} | ${fd} | ${ratioDeviation(m)} | ${m.limits.hardLimit} | ${m.limits.firstBudget}${m.limits.minBudget !== m.limits.firstBudget ? `->${m.limits.minBudget}` : ""} | ${m.calls} | ${fmt(m.runtimeMs / 1000, 0)} |`;
	});
	return [head, sep, ...rows].join("\n");
}

let failed = false;
const loaded = dirs.map(load);
for (const { dir, engine, runs } of loaded) {
	if (runs.length === 0) {
		console.error(`E2: no runs in ${dir}`);
		failed = true;
		continue;
	}
	// N2: a misconfigured run (replayedReasoning against its provider) is expected to fail its own criteria; it
	// is reported in its own section and gated only on its replay warning.
	const fails = runs.filter((m) => m.verdict !== "PASS" && !m.config.replayMisconfigured && !isKnown(m));
	const known = runs.filter(isKnown);
	const criteriaFails = {};
	for (const m of runs)
		if (!m.config.replayMisconfigured && !isKnown(m))
			for (const c of m.criteria) if (c.pass === false) criteriaFails[c.id] = (criteriaFails[c.id] ?? 0) + 1;
	const expected = Number(process.env.E2_EXPECT_RUNS ?? 0);
	const knownLines = knownReport(runs, expected > 0 && runs.length >= expected);
	const knownNote = known.length
		? `, KNOWN ${known.length} (${known.map((m) => `${m.id} ${knownOf(m).entry.criterion.split(" ")[0]} lag ${m.silent.lagToDetection}, until ${knownOf(m).entry.until}`).join("; ")})`
		: "";
	const shas = [...new Set(runs.map((m) => m.engine.sha256))];
	const corpora = [...new Set(runs.map((m) => m.corpusFingerprint))];
	const tokenizers = [...new Set(runs.map((m) => m.tokenizer))];
	const totalS = runs.reduce((s, m) => s + m.runtimeMs, 0) / 1000;
	const selftest = existsSync(join(dir, "selftest.json")) ? "yes (selftest.json)" : "not run";
	const c3 = c3Trend(runs);
	const c8 = c8Report(runs);
	const replay = replayReport(runs);
	const md = [
		`# E2 summary: ${engine.label ?? runs[0].engine.label}`,
		"",
		`- engine: ${runs[0].engine.label}, SHA-256 ${shas.join(", ")}${shas.length > 1 ? " (**several engine versions in one directory**)" : ""}`,
		`- engine source: ${runs[0].engine.source} (loaded ${runs[0].engine.via})`,
		`- tokenizers: ${tokenizers.join("; ")}`,
		`- corpus fingerprint: ${corpora.join(", ")}`,
		`- runs: ${runs.length}, PASS ${runs.length - fails.length - known.length}, FAIL ${fails.length}${knownNote}; failing criteria: ${Object.entries(criteriaFails).map(([k, v]) => `${k} x${v}`).join(", ") || "none"}`,
		`- session runtime (sum over runs): ${fmt(totalS, 0)} s; self-test: ${selftest}`,
		"",
		"Request sizes are real tokens of the request as sent, divided by the input budget the engine planned that request with. Cells start with ok / vacuous (passed because nothing was silently truncated) / n/a / **FAIL**. \"ratio err\" is the engine's calibration ratio over the true ratio (real tokens / engine estimate), min..max over the 25-call trace. README.md explains each criterion and its threshold.",
		"",
		table(runs),
		"",
		"## Known failures",
		"",
		"Entries of known-failures.json: a run failing one named criterion within a recorded bound, accepted by decision until a PENpi version. The run's own result still says FAIL; the summary counts it as KNOWN.",
		"",
		...knownLines.lines,
		"",
		"## Worst cases",
		"",
		...worst(runs).map((w) => `- ${w}`),
		"",
		"## C3 trend",
		"",
		`Mean request / budget after the first cut, across ${c3.runs} runs: min ${fmt(c3.min, 3)}, p10 ${fmt(c3.p10, 3)}, median ${fmt(c3.median, 3)}, mean ${fmt(c3.mean, 3)}; ${c3.belowHalf} run(s) below 0.50. Gate: >= ${c3.floor}. Track these between runs (E2_TREND_FILE): a falling median is an estimator or planner regression even while every run passes.`,
		"",
		c8.totals.runs
			? `Band-exempt truncations (C8: inside the band and unnamed), across ${c8.totals.runs} silent runs: ${c8.totals.unnamedInBand} of ${c8.totals.truncated} truncated requests (${fmt(c8.totals.bandExemptShare, 3)}), ${c8.totals.inBandTokens ?? "n/a"} tokens lost. Gate: at most ${BAND_EXEMPT_CEILING} of truncated requests once ${BAND_EXEMPT_MIN_TRUNCATED} are truncated${c8.totals.bandExemptFail ? "; **FAIL**" : ""}.`
			: "Band-exempt truncations: no silent runs.",
		...(c8.mostlyExempt.length
			? ["", `Runs whose truncations are mostly band-exempt (reported): ${c8.mostlyExempt.join("; ")}.`]
			: []),
		"",
		...(replay.misconfigured
			? [
					"## Misconfigured runs",
					"",
					'replayedReasoning "ignored" against a provider that counts it. Reported, not gated by their criteria; the gate is the warning.',
					"",
					"| run | verdict (failing criteria) | C1 late rejections | C2 max/budget | rejections | overflow retries | qualifying pairs | median share | warned |",
					"|---|---|---|---|---|---|---|---|---|",
					...runs
						.filter((m) => m.config.replayMisconfigured)
						.map((m) => {
							const failing = m.criteria.filter((c) => c.pass === false).map((c) => c.id);
							const check = Object.values(m.engineStats?.replayCheck ?? {})[0];
							const warned = (m.engineStats?.replayWarnings?.length ?? 0) > 0;
							return `| ${m.id} | ${m.verdict}${failing.length ? ` (${failing.join(", ")})` : ""} | ${m.rejections.late} | ${fmt(m.largest.shareOfBudget)} | ${m.rejections.count} | ${m.engineStats?.overflowRetries ?? "-"} | ${check?.pairs ?? 0} | ${fmt(check?.median)} | ${warned ? "yes" : "**no**"} |`;
						}),
					"",
				]
			: []),
		"## Replay check",
		"",
		replay.misconfigured
			? `${replay.warned} of ${replay.misconfigured} misconfigured runs (replayedReasoning "ignored", provider counts) warned${replay.missing.length ? `; **FAIL**, no warning in ${replay.missing.join(", ")}` : ""}.`
			: "No misconfigured runs.",
		replay.unexpected.length
			? `**FAIL**: a replay warning in a run whose setting matches its provider: ${replay.unexpected.join(", ")}.`
			: "No replay warning in any other run.",
		"",
		"## C8 named answers",
		"",
		c8.totals.runs
			? `Across ${c8.totals.runs} silent runs: ${c8.totals.truncated} truncated requests, ${c8.totals.visible} outside the band (lost more than plateauFlatness + the estimate error, the error capped at 0.05), ${c8.totals.named} answers named. Unnamed outside the band (fail): ${c8.totals.unnamed}. Unnamed inside the band (reported): ${c8.totals.unnamedInBand}. Named without truncation (reported): ${c8.totals.wronglyNamed} in ${c8.totals.runsWithWrongNames} run(s); false-name rate ${fmt(c8.totals.falseNameRate, 3)} of named answers (gate: at most ${FALSE_NAME_CEILING} once ${FALSE_NAME_MIN_NAMES} answers are named${c8.totals.falseNamesFail ? "; **FAIL**" : ""}).`
			: "No silent runs.",
		"",
		...(c8.lines.length
			? [
					"| run | truncated | outside band | named | unnamed (fail) | unnamed in band | named without truncation |",
					"|---|---|---|---|---|---|---|",
					...c8.lines,
					"",
				]
			: []),
	].join("\n");
	writeFileSync(join(dir, "summary.md"), md);
	writeFileSync(
		join(dir, "summary.json"),
		JSON.stringify(
			{
				engine: runs[0].engine,
				shas,
				runs: runs.map((m) => ({ id: m.id, verdict: m.verdict, criteria: m.criteria, largest: m.largest, share: m.share, rejections: m.rejections, cuts: m.cuts.count, breaks: m.prefix.breaks, silent: m.silent, runtimeMs: m.runtimeMs })),
				failing: fails.map((m) => m.id),
				known: known.map((m) => ({ id: m.id, criterion: knownOf(m).entry.criterion, lag: m.silent.lagToDetection, until: knownOf(m).entry.until })),
				knownProblems,
				c3,
				c8: c8.totals,
				replay,
				totalRuntimeS: totalS,
			},
			null,
			2,
		),
	);
	console.log(md);
	if (process.env.E2_TREND_FILE) {
		// One line per summarized directory, appended, so CI can keep a running trend of C3, the band-exempt
		// truncations and the verdicts.
		mkdirSync(dirname(process.env.E2_TREND_FILE), { recursive: true });
		appendFileSync(
			process.env.E2_TREND_FILE,
			`${JSON.stringify({ at: new Date().toISOString(), dir, engine: runs[0].engine.label, sha256: shas.join(","), seed: runs[0].config.seed, runs: runs.length, fail: fails.length, c3, bandExempt: { count: c8.totals.unnamedInBand, truncated: c8.totals.truncated, tokens: c8.totals.inBandTokens } })}\n`,
		);
	}
	if (fails.length > 0) failed = true;
	if (knownLines.fail) {
		console.error(`E2: ${dir}: known failures need attention (see "Known failures" in summary.md)`);
		failed = true;
	}
	if (c8.totals.falseNamesFail) {
		console.error(
			`E2: ${dir}: C8 false-name rate ${c8.totals.falseNameRate.toFixed(3)} is above ${FALSE_NAME_CEILING} (${c8.totals.wronglyNamed} of ${c8.totals.named} names)`,
		);
		failed = true;
	}
	if (replay.unexpected.length || replay.missing.length) {
		console.error(
			`E2: ${dir}: replay check: ${replay.unexpected.length} unexpected warning(s) (${replay.unexpected.join(", ")}), ${replay.missing.length} misconfigured run(s) without one (${replay.missing.join(", ")})`,
		);
		failed = true;
	}
	if (c8.totals.bandExemptFail) {
		console.error(
			`E2: ${dir}: C8 band-exempt truncations ${c8.totals.bandExemptShare.toFixed(3)} of truncated requests are above ${BAND_EXEMPT_CEILING} (${c8.totals.unnamedInBand} of ${c8.totals.truncated})`,
		);
		failed = true;
	}
	if (expected && runs.length < expected) {
		console.error(`E2: ${dir} has ${runs.length} runs, expected ${expected}`);
		failed = true;
	}
}

if (loaded.length > 1) {
	const ids = [...new Set(loaded.flatMap((l) => l.runs.map((m) => m.id)))].sort();
	const head = `| run | ${loaded.map((l) => `${l.runs[0]?.engine.label ?? "?"} ${l.runs[0]?.engine.sha256.slice(0, 12) ?? ""}`).join(" | ")} |`;
	const sep = `|---|${loaded.map(() => "---").join("|")}|`;
	const shaRow = `| engine SHA-256 | ${loaded.map((l) => [...new Set(l.runs.map((m) => m.engine.sha256))].join(", ")).join(" | ")} |`;
	const rows = ids.map((id) => {
		const cells = loaded.map((l) => {
			const m = l.runs.find((r) => r.id === id);
			if (!m) return "-";
			const f = m.criteria.filter((c) => c.pass === false).map((c) => c.id.split(" ")[0]);
			const vac = m.criteria.some((c) => c.pass && c.note?.startsWith("vacuous")) ? " (vacuous)" : "";
			const silent = m.silent
				? ` trunc ${m.silent.truncated} lag ${m.silent.lagToDetection ?? (m.silent.truncated ? "undetected" : 0)}`
				: "";
			return `${m.verdict === "PASS" ? `PASS${vac}` : `**FAIL** ${f.join(",")}`} max ${fmt(m.largest.shareOfBudget)} mean ${fmt(meanAfterFirstCut(m) ?? m.share.mean)} rej ${m.rejections.late}${silent}`;
		});
		return `| ${id} | ${cells.join(" | ")} |`;
	});
	const counts = loaded.map((l) => {
		const fails = l.runs.filter((m) => m.verdict !== "PASS").length;
		return `${l.runs[0]?.engine.label ?? "?"}: ${l.runs.length - fails} PASS / ${fails} FAIL`;
	});
	const md = [
		"# E2 comparison",
		"",
		`Runs: ${counts.join("; ")}. Cells: verdict (failing criteria), max = largest request / budget, mean = mean request / budget after the first cut, rej = rejections after call 4, trunc / lag = silently truncated requests and how many came before the engine's first detection.`,
		"",
		head,
		sep,
		shaRow,
		...rows,
		"",
	].join("\n");
	console.log(md);
	if (process.env.E2_COMPARE_OUT) writeFileSync(process.env.E2_COMPARE_OUT, md);
}

process.exit(failed ? 1 : 0);
