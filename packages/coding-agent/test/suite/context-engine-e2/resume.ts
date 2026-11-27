/**
 * E2 resume (run-e2.sh): a retry keeps the runs that already passed and reruns the rest, so a stopped or failed
 * matrix doesn't start over. E2_FRESH=1 starts over.
 *
 * A results folder is stamped (.resume-key) with what made its runs: the checkout (HEAD's tree, the working tree's
 * changes and its untracked files), the engine's sha256, the corpus revision asked for, and every E2_ and PENPI_
 * variable but those that only choose runs or where output goes. run-e2.sh starts each attempt here: a missing or
 * different stamp, or E2_FRESH=1, clears the folder's results as before; the same stamp keeps them. Each matrix file
 * then checks its own runs (suite.ts): a run kept is one whose <run>.json passed with the same config; a missing,
 * unreadable, failed or changed run reruns, its old files removed first. Each selected run is listed in .selection,
 * so the summary reads the kept and the new results together and nothing else in the folder, and in .kept or
 * .rerun, which run-e2.sh prints after the matrix.
 *
 *   node resume.ts start <results folder> <engine sha256>   # stamps the folder; clears it unless resuming
 *   node resume.ts report <results folder>                  # which runs were kept, and which ran and why
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { REPO_ROOT, resolveRev } from "./corpus.ts";

/** Variables that only choose runs, name paths or shape output: a retry may change them and keep its results. */
const OPERATIONAL = new Set([
	"E2_ASSERT",
	"E2_COMPARE_OUT",
	"E2_DEFAULT_MATRIX",
	"E2_DUMP_DROPPED",
	"E2_ENGINE",
	"E2_ENGINE_LABEL",
	"E2_ENGINE_SOURCE",
	"E2_EXPECT_RUNS",
	"E2_FRESH",
	"E2_HF_DIR",
	"E2_KNOWN_FAILURES",
	"E2_MIXES",
	"E2_MODES",
	"E2_OUT",
	"E2_OUT_ROOT",
	"E2_PIN_REQUIRED",
	"E2_RESUME",
	"E2_SCRATCH",
	"E2_SKIP_SELFTEST",
	"E2_SKIP_SETUP",
	"E2_TOKENIZERS",
	"E2_TOK_DIR",
	"E2_TREND_FILE",
	"E2_WINDOWS",
	"E2_WORKERS",
]);

/** The files of one run in a results folder. */
const runFiles = (id: string): string[] => [`${id}.json`, `${id}.engine.log`, `${id}.dropped.jsonl`];
/** The attempt's lists: the runs selected, kept and rerun. */
const LISTS = [".selection", ".kept", ".rerun"];

function git(args: string[]): Buffer {
	return execFileSync("git", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 30 });
}

/** What the checkout holds: HEAD's tree, plus the working tree's changes and untracked files, by content. */
export function checkoutKey(): string {
	const hash = createHash("sha256");
	hash.update(git(["rev-parse", "HEAD^{tree}"]));
	hash.update(git(["diff", "HEAD", "--binary"]));
	for (const path of git(["ls-files", "-o", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean).sort())
		hash
			.update(path)
			.update("\0")
			.update(existsSync(join(REPO_ROOT, path)) ? readFileSync(join(REPO_ROOT, path)) : "");
	return hash.digest("hex");
}

/** The stamp a results folder's runs are made under. */
export function resumeKey(env: NodeJS.ProcessEnv, engineSha: string, checkout: string): string {
	const asked = env.E2_CORPUS_REV;
	const corpus = asked && asked !== "worktree" ? resolveRev(asked) : (asked ?? "pin");
	const settings = Object.keys(env)
		.filter((k) => (k.startsWith("E2_") || k.startsWith("PENPI_")) && !OPERATIONAL.has(k))
		.sort()
		.map((k) => `${k}=${env[k]}`);
	return createHash("sha256").update(JSON.stringify({ checkout, engineSha, corpus, settings })).digest("hex");
}

/**
 * Starts an attempt in `out`: returns why every run reruns, or undefined for a resume. A fresh attempt clears the
 * results, as run-e2.sh always did; either way the stamp is written and the attempt's lists start empty.
 */
export function startAttempt(out: string, key: string, freshAsked: boolean): string | undefined {
	const stamp = existsSync(join(out, ".resume-key")) ? readFileSync(join(out, ".resume-key"), "utf8").trim() : "";
	const fresh = freshAsked
		? "E2_FRESH=1"
		: !stamp
			? "no earlier attempt in this folder"
			: stamp !== key
				? "the checkout, engine, corpus or E2 settings differ from the earlier attempt"
				: undefined;
	if (fresh)
		for (const f of readdirSync(out))
			if (f.endsWith(".json") || f.endsWith(".engine.log") || f.endsWith(".dropped.jsonl")) rmSync(join(out, f));
	for (const f of ["summary.md", "vitest.log", ".resuming", ...LISTS]) rmSync(join(out, f), { force: true });
	writeFileSync(join(out, ".resume-key"), `${key}\n`);
	// run-e2.sh tells the matrix files (E2_RESUME=1) when this marker is there.
	if (!fresh) writeFileSync(join(out, ".resuming"), "");
	return fresh;
}

export type RunPlan = "keep" | "missing" | "unreadable" | "failed" | "changed";

/** Whether a selected run keeps its result in `out` (a resumed attempt only): its <run>.json passed with `config`. */
export function planRun(out: string, config: { id: string }): RunPlan {
	const file = join(out, `${config.id}.json`);
	if (!existsSync(file)) return "missing";
	let result: { verdict?: string; config?: unknown };
	try {
		result = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return "unreadable";
	}
	if (result.verdict !== "PASS") return "failed";
	return isDeepStrictEqual(result.config, JSON.parse(JSON.stringify(config))) ? "keep" : "changed";
}

/**
 * The matrix files' side (suite.ts): plans one selected run, lists it, and removes the files of a run that reruns.
 * Returns whether the run is kept.
 */
export function selectRun(out: string, config: { id: string }, resuming: boolean): boolean {
	const plan = resuming ? planRun(out, config) : "missing";
	appendFileSync(join(out, ".selection"), `${config.id}\n`);
	if (plan === "keep") {
		appendFileSync(join(out, ".kept"), `${config.id}\n`);
		return true;
	}
	if (resuming) appendFileSync(join(out, ".rerun"), `${config.id} (${plan})\n`);
	for (const f of runFiles(config.id)) rmSync(join(out, f), { force: true });
	return false;
}

const lines = (file: string): string[] =>
	existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

/** The runs selected in the attempt (<out>/.selection), or undefined for a folder from before resumes. */
export function selectedRuns(out: string): Set<string> | undefined {
	return existsSync(join(out, ".selection")) ? new Set(lines(join(out, ".selection"))) : undefined;
}

/** What a resumed attempt kept and reran, as run-e2.sh prints it; nothing for a fresh one. */
export function describeAttempt(out: string): string {
	const kept = lines(join(out, ".kept"));
	const rerun = lines(join(out, ".rerun")).sort();
	if (kept.length === 0 && rerun.length === 0) return "";
	return [
		`E2: resume: ${kept.length} of ${kept.length + rerun.length} runs kept, ${rerun.length} run`,
		...rerun.map((r) => `E2:   ran ${r}`),
	].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, out, engineSha] = process.argv.slice(2);
	if (command === "start" && out && engineSha) {
		const fresh = startAttempt(out, resumeKey(process.env, engineSha, checkoutKey()), process.env.E2_FRESH === "1");
		console.log(
			fresh ? `E2: every selected run (${fresh})` : "E2: resume: runs that passed under the same stamp are kept",
		);
	} else if (command === "report" && out) {
		const text = describeAttempt(out);
		if (text) console.log(text);
	} else {
		console.error("usage: node resume.ts start <results folder> <engine sha256> | report <results folder>");
		process.exit(2);
	}
}
