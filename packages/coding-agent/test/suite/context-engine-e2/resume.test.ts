/**
 * E2 resume (resume.ts, run-e2.sh, suite.ts): a retry keeps the runs that passed with the same config under the
 * same stamp, reruns the missing, unreadable, failed and changed ones and says why, and starts over on E2_FRESH=1
 * or a different stamp.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeAttempt, resumeKey, selectedRuns, selectRun, startAttempt } from "./resume.ts";

const ids = [
	"a.o200k.32k.reject",
	"b.o200k.32k.reject",
	"c.o200k.32k.reject",
	"d.o200k.32k.reject",
	"e.o200k.32k.reject",
];
const configs = ids.map((id) => ({ id, turns: 500, seed: 1 }));

describe("E2 resume", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	/** A folder from an earlier attempt under stamp `key`: one run of each kind, and one outside this selection. */
	function folder(key: string): string {
		const out = mkdtempSync(join(tmpdir(), "e2-resume-"));
		dirs.push(out);
		writeFileSync(join(out, ".resume-key"), `${key}\n`);
		const result = (id: string, verdict: string, config: unknown) => {
			writeFileSync(join(out, `${id}.json`), JSON.stringify({ id, verdict, config, criteria: [] }));
			writeFileSync(join(out, `${id}.engine.log`), "log\n");
		};
		result(ids[0], "PASS", configs[0]); // kept
		result(ids[1], "FAIL", configs[1]); // failed
		result(ids[2], "PASS", { ...configs[2], seed: 2 }); // changed
		writeFileSync(join(out, `${ids[3]}.json`), '{"id":'); // stopped mid-write
		// e: missing.
		result("z.glm.1m.reject", "PASS", { id: "z.glm.1m.reject" });
		writeFileSync(join(out, "summary.md"), "old\n");
		return out;
	}

	it("a retry under the same stamp keeps what passed with the same config, reruns the rest, and says why", () => {
		const out = folder("K");
		expect(startAttempt(out, "K", false)).toBeUndefined();
		expect(existsSync(join(out, ".resuming"))).toBe(true);
		expect(existsSync(join(out, "summary.md"))).toBe(false);
		const kept = configs.map((c) => selectRun(out, c, true));
		expect(kept).toEqual([true, false, false, false, false]);
		expect(existsSync(join(out, `${ids[0]}.json`))).toBe(true);
		expect(existsSync(join(out, `${ids[0]}.engine.log`))).toBe(true);
		expect(existsSync(join(out, `${ids[1]}.json`))).toBe(false);
		expect(existsSync(join(out, `${ids[1]}.engine.log`))).toBe(false);
		expect(existsSync(join(out, `${ids[3]}.json`))).toBe(false);
		// Outside this selection: left alone, and left out of the summary.
		expect(existsSync(join(out, "z.glm.1m.reject.json"))).toBe(true);
		expect([...(selectedRuns(out) ?? [])]).toEqual(ids);
		expect(describeAttempt(out).split("\n")).toEqual([
			"E2: resume: 1 of 5 runs kept, 4 run",
			`E2:   ran ${ids[1]} (failed)`,
			`E2:   ran ${ids[2]} (changed)`,
			`E2:   ran ${ids[3]} (unreadable)`,
			`E2:   ran ${ids[4]} (missing)`,
		]);
	});

	it("starts over on E2_FRESH=1, on a different stamp, and in a new folder, and says why", () => {
		for (const [key, fresh, why] of [
			["K", true, "E2_FRESH=1"],
			["other", false, "the checkout, engine, corpus or E2 settings differ from the earlier attempt"],
		] as const) {
			const out = folder("K");
			expect(startAttempt(out, key, fresh)).toBe(why);
			expect(existsSync(join(out, ".resuming"))).toBe(false);
			expect(existsSync(join(out, `${ids[0]}.json`))).toBe(false);
			expect(existsSync(join(out, "z.glm.1m.reject.json"))).toBe(false);
			expect(readFileSync(join(out, ".resume-key"), "utf8")).toBe(`${key}\n`);
			expect(configs.map((c) => selectRun(out, c, false))).toEqual([false, false, false, false, false]);
			expect(describeAttempt(out)).toBe("");
		}
		const first = mkdtempSync(join(tmpdir(), "e2-resume-"));
		dirs.push(first);
		expect(startAttempt(first, "K", false)).toBe("no earlier attempt in this folder");
	});

	it("the stamp follows the checkout, the engine and the settings that shape a run, not the selection or paths", () => {
		const env = {
			E2_TURNS: "60",
			E2_EXACT: "1",
			PENPI_TOKENIZER: "local",
			E2_MODES: "reject",
			E2_OUT: "/x",
			HOME: "/h",
		};
		const key = resumeKey(env, "sha", "tree");
		const moved = { ...env, E2_MODES: "reasoning", E2_OUT: "/y", E2_WORKERS: "4", E2_RESUME: "1", HOME: "/g" };
		expect(resumeKey(moved, "sha", "tree")).toBe(key);
		expect(resumeKey({ ...env, E2_TURNS: "500" }, "sha", "tree")).not.toBe(key);
		expect(resumeKey({ ...env, PENPI_TOKENIZER: "estimate" }, "sha", "tree")).not.toBe(key);
		expect(resumeKey({ ...env, E2_SILENT_LIMIT: "window" }, "sha", "tree")).not.toBe(key);
		expect(resumeKey(env, "other", "tree")).not.toBe(key);
		expect(resumeKey(env, "sha", "edited")).not.toBe(key);
	});
});
