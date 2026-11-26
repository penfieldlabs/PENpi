/**
 * 0.9.0, ADR 0035: the silent-truncation detector on honest content, a guard for any detection rule. An honest
 * provider counts with o200k and a scale of its own per kind of content (0.7 to 1.8, drawn per seed: tokenizers differ
 * by kind), on one model with a 32,000- or 48,000-token window, so the engine cuts often. The provider never
 * truncates: it rejects only above the declared window and reports what it counted, so every detection is false.
 * Three mixes:
 * - "shapes": ADR 0033's honest shapes (unittest dots, `git diff --stat` bars, base64 of zeros, `-=` rules, blank CRLF
 *   lines, comment markers, ellipses, closing brackets, numbers, Chinese, random base64, floor-sweep units, prose);
 * - "corpus": text cut from the E2 corpus (prose, markup, code, JSON, logs, tables, Chinese, Japanese, base64,
 *   whitespace);
 * - "mixed": both.
 *
 * Every session also resends requests, twice after each of its four prompts, with the engine keeping its state, as
 * for a resend it is not told about:
 * - by the route a real session takes: the prompt's last answer sends nothing (it is empty, which Pi's converter
 *   skips), and an entry that isn't sent (a custom type the engine hides) triggers a turn, so that request is the
 *   last one again, append-only with nothing appended;
 * - from the same point (resendAnswered): one request of that prompt is sent again, the one that set the largest
 *   usage reported so far when one in that prompt did, with a chance of 0.8, and otherwise one at random. When the
 *   engine has cut since, what it sends differs.
 * The kind scales stay free, so the first estimate of a resent request can be off by a few percent either way. The
 * records keep only the resends that reported the same count as the request they repeat. Those are the shape ADR
 * 0035's different-request guard is there to stop: an honest repeat of exactly the maximum, expected within the
 * allowance below it.
 *
 * Variants are engine options. "shipped" (the shipped defaults) is the baseline and always runs; a candidate rule
 * runs as further variants, each an object of createContextEngine options. The bars, for any new rule, fixed before
 * its first run:
 * - Safety: the baseline detects in no session. Every session that detects with a candidate also detects with the
 *   baseline, and not at a later call: the rule adds no detection and makes none earlier.
 * - Power: the test must reach the case the rule's guard is there to stop. The rule without its guard detects on
 *   some sessions, and the baseline's sessions hold the guarded shape (for ADR 0035's oldest-message rule: a growth
 *   marginal, then a match within 30 samples) at least 20 times in at least 10 sessions. Otherwise the test never
 *   meets the guard and proves nothing; widen the mix and say how. The counts come from the logged rows.
 * - Power for ADR 0035's exact repeat, by the logged rows of the baseline: samples that report exactly the largest
 *   usage reported so far again for the same request, expected within the allowance below it ("exact repeat not
 *   judged" rows with the expected size below the maximum), at least 20 times in at least 10 sessions. The test counts
 *   it itself: each full run writes its part ("Power: N in M sessions", power.<seeds>.json and .txt under
 *   HONEST_OUT), and with HONEST_POWER_SUM=1 the test adds up the parts under HONEST_OUT and its folders and asserts
 *   the bar, once they cover seeds 0 to 49, all three mixes and both windows. A full run is split by seed range, one
 *   corpus per range, so the bar is asserted on the sum.
 *
 * Two runs:
 * - by default, a slice for CI that needs no corpus: the shapes mix, 32,000 tokens, seeds 0 to 9, the shipped engine
 *   only, with no detection, and at least one guarded repeat (seed 1 holds two);
 * - with HONEST_DETECTION=1, the full run, on demand (before a new detection rule and before each release gate): all
 *   three mixes at both windows, seeds 0 to 49, on a corpus named with E2_CORPUS_REV (v1.4.0 to v1.5.1; v1.6.0 is
 *   held out and refused). It writes one JSON per session and variant to HONEST_OUT. HONEST_VARIANTS (JSON:
 *   {"name": {options}}), HONEST_SEEDS ("0-49"), HONEST_MIXES and HONEST_WINDOWS narrow or extend it.
 *   It also runs every session with a provider that rounds its usage to 100 tokens (HONEST_REPORTERS, "exact,round100"
 *   by default), a provider kind the engine does not support yet. Those sessions are recorded, not failed: until the
 *   engine has a guard for rounding, a detection there is expected.
 *
 * Each session runs in a working folder of its own fixed name (penpi-honest-<mix>-<window>-<seed>-<reporter> under
 * the system's temp folder). The folder is in the system prompt, so a session's requests, and every figure, come out
 * the same on every run, and a session can be replayed. The records carry each call's reported usage and each
 * request's estimate, to compare two runs call for call.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { type ContentClass, generate, rng } from "../context-engine-e2/content.ts";
import { resolveRev } from "../context-engine-e2/corpus.ts";
import { installProviderSim } from "../context-engine-e2/provider-sim.ts";
import { CountingTokenizer, type Tokenizer } from "../context-engine-e2/tokenizers.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { sweepUnits } from "./floor-sweep-cases.ts";
import { blobExtension, LOG_DIR, resendAnswered, scriptedModel, syntheticText } from "./helpers.ts";
import { fastO200k } from "./o200k-fast.ts";

const FULL = process.env.HONEST_DETECTION === "1";
/** Sum the Power parts under HONEST_OUT and assert the bar, instead of running sessions. */
const POWER_SUM = process.env.HONEST_POWER_SUM === "1";
const HELD_OUT = "faac585884ae2c013a6b1400f3e9e77f10b34bac";
const BASELINE = "shipped";
const VARIANTS: Record<string, Record<string, unknown>> = {
	[BASELINE]: {},
	...(FULL && process.env.HONEST_VARIANTS
		? (JSON.parse(process.env.HONEST_VARIANTS) as Record<string, Record<string, unknown>>)
		: {}),
};
const MIXES = FULL ? (process.env.HONEST_MIXES ?? "shapes,corpus,mixed").split(",") : ["shapes"];
const WINDOWS = FULL ? (process.env.HONEST_WINDOWS ?? "32000,48000").split(",").map(Number) : [32_000];
const [from, to] = (FULL ? (process.env.HONEST_SEEDS ?? "0-49") : "0-9").split("-").map(Number);
const SEEDS = Array.from({ length: (to ?? from) - from + 1 }, (_, i) => from + i);
const REPORTERS = FULL ? (process.env.HONEST_REPORTERS ?? "exact,round100").split(",") : ["exact"];
const OUT = process.env.HONEST_OUT ?? join(LOG_DIR, "honest-detection");
const PROMPTS = 4;
const CALLS = 40;
/** The custom type of the entry that triggers a turn and is never sent (the engine's hiddenCustomTypes). */
const UNSENT = "honest-unsent";

/** o200k with a heap merge (o200k-fast.ts): the same tokens as js-tiktoken, and fast on long runs of one character. */
const O200K: Tokenizer = { name: "o200k", source: "o200k-fast.ts", count: fastO200k };

/** Counts with o200k, then scales each tool result's text by the scale of its kind: honest, a fixed count per text. */
class KindCounter extends CountingTokenizer {
	private scales: Map<string, number>;
	constructor(tokenizer: Tokenizer, scales: Map<string, number>) {
		super(tokenizer);
		this.scales = scales;
	}
	/** Texts counted at a kind's scale (tool results), and long texts counted at 1, for the record. */
	scaled = 0;
	unscaled: Array<{ chars: number; head: string }> = [];
	override count(text: string): number {
		const n = super.count(text);
		const scale = this.scales.get(text);
		if (scale !== undefined) this.scaled++;
		else if (text.length > 1_000 && this.unscaled.length < 20)
			this.unscaled.push({ chars: text.length, head: JSON.stringify(text.slice(0, 100)) });
		return scale === undefined ? n : Math.round(n * scale);
	}
}

const zh = readFileSync(new URL("./samples/zh.txt", import.meta.url), "utf8");
const units = sweepUnits();
const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
type Maker = (r: () => number, size: number, seed: number) => string;
const int = (r: () => number, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const cut = (text: string, size: number) => text.slice(0, size);

/** ADR 0033's honest shapes (honest-provider.test.ts) and the suite's other honest kinds, about `size` characters. */
const SHAPES: Record<string, Maker> = {
	unittest: (_r, size) => `${".".repeat(Math.max(10, size - 90))}\n${"-".repeat(70)}\nRan tests in 41.512s\n\nOK\n`,
	diffstat: (_r, size) =>
		cut(
			rep(
				Math.ceil(size / 60),
				(i) =>
					` src/module_${i}/handler_${i}.ts | ${String(10 + ((i * 7) % 90)).padStart(3)} ${"+".repeat(10 + ((i * 7) % 40))}${"-".repeat((i * 3) % 20)}\n`,
			),
			size,
		),
	zeros64: (_r, size) => Buffer.alloc(Math.floor((size * 3) / 4)).toString("base64"),
	rules: (_r, size) =>
		cut(
			rep(Math.ceil(size / 82), (i) => `section ${i}\n${"-=".repeat(35)}\n`),
			size,
		),
	crlf: (_r, size) => `Output:\r\n${"\r\n".repeat(Math.floor(size / 2))}Done.\r\n`,
	counter: (_r, size) =>
		cut(
			rep(Math.ceil(size / 18), (i) => `${i}${"\r\n".repeat(8)}`),
			size,
		),
	slashes: (r, size) =>
		cut(
			rep(Math.ceil(size / 3), () => ["//\n", "// \n", "//\n\n"][int(r, 0, 2)]),
			size,
		),
	ellipses: (_r, size) =>
		cut(
			rep(Math.ceil(size / 14), (i) => `${"…".repeat(4 + (i % 12))}${"\r\n".repeat(2 + (i % 6))}`),
			size,
		),
	mid: (r, size) =>
		cut(
			rep(Math.ceil(size / 6), (i) => `${i} //${"\n".repeat(int(r, 1, 3))}`),
			size,
		),
	five: (r, size) =>
		cut(
			rep(Math.ceil(size / 6), () => ["// //\n", "// // \n", `// //${"\n".repeat(int(r, 1, 3))}`][int(r, 0, 2)]),
			size,
		),
	star: (r, size) =>
		cut(
			rep(Math.ceil(size / 5), () => ["// *\n", "// *\n\n", "//*\n"][int(r, 0, 2)]),
			size,
		),
	arrow: (r, size) =>
		cut(
			rep(Math.ceil(size / 20), () => `-->\n${" ".repeat(int(r, 8, 60))}`),
			size,
		),
	close: (r, size) =>
		cut(
			rep(Math.ceil(size / 20), () => `});\n${" ".repeat(int(r, 8, 60))}`),
			size,
		),
	four: (r, size) =>
		cut(
			rep(Math.ceil(size / 13), () => `// // // //${"\n".repeat(int(r, 1, 3))}`),
			size,
		),
	numbers: (_r, size, seed) =>
		cut(
			rep(Math.ceil(size / 6), (k) => `${(k + seed) * 7919} `),
			size,
		),
	zh: (r, size) => {
		const at = int(r, 0, Math.max(0, zh.length - size));
		return zh.repeat(Math.ceil(size / zh.length) + 1).slice(at, at + size);
	},
	random64: (r, size) =>
		Buffer.from(Array.from({ length: Math.floor((size * 3) / 4) }, () => int(r, 0, 255))).toString("base64"),
	units: (r, size) => {
		const u = units[int(r, 0, units.length - 1)];
		return `${u}\n`.repeat(Math.ceil(size / (u.length + 1))).slice(0, size);
	},
	prose: (_r, size, seed) => syntheticText(size, seed),
};
const CORPUS_KINDS: ContentClass[] = [
	"prose",
	"markup",
	"code",
	"json",
	"json-min",
	"log",
	"table",
	"zh",
	"ja",
	"base64",
	"whitespace",
];
const CORPUS: Record<string, Maker> = Object.fromEntries(
	CORPUS_KINDS.map((k) => [`e2-${k}`, (_r: () => number, size: number, seed: number) => generate(k, size, seed).text]),
);
const MIX_KINDS: Record<string, Record<string, Maker>> = {
	shapes: SHAPES,
	corpus: CORPUS,
	mixed: { ...SHAPES, ...CORPUS },
};

interface Row {
	/** The sample being judged (1-based, stats.calibrationSamples). */
	s: number;
	/** Provider calls made so far. */
	call: number;
	line: string;
}

/** A session's tool results, each with its kind and that kind's provider scale. */
function sessionBlobs(mix: string, window: number, seed: number) {
	const r = rng(seed * 7_919 + window + mix.length);
	const makers = MIX_KINDS[mix];
	const kinds = Object.keys(makers);
	const kindScale = new Map(kinds.map((k) => [k, Math.round((0.7 + 1.1 * r()) * 100) / 100]));
	const scales = new Map<string, number>();
	const blobs: Record<string, { text: string }> = {};
	const used: string[] = [];
	for (let i = 0; i < PROMPTS * CALLS; i++) {
		const kind = kinds[int(r, 0, kinds.length - 1)];
		const size = int(r, 1_500, 12_000);
		const text = makers[kind](r, size, seed * 1_000 + i) || ".";
		blobs[`b${i}`] = { text };
		scales.set(text, kindScale.get(kind)!);
		used.push(kind);
	}
	return { blobs, scales, used, kindScale };
}

async function session(
	mix: string,
	window: number,
	seed: number,
	options: Record<string, unknown>,
	harnesses: Harness[],
	reporter = "exact",
) {
	const { blobs, scales, used, kindScale } = sessionBlobs(mix, window, seed);
	// The resend choices, drawn from their own stream so the blobs stay as they were.
	const pick = rng(seed * 104_729 + window + mix.length);
	const started = performance.now();
	const stats = newStats();
	const rows: Row[] = [];
	let calls = 0;
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		// A fixed working folder per session: it is in the system prompt, so the session's requests come out the same
		// on every run, and a session can be replayed.
		tempDir: join(tmpdir(), `penpi-honest-${mix}-${window}-${seed}-${reporter}`),
		models: [{ id: "honest", contextWindow: window, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			blobExtension(blobs),
			(pi: ExtensionAPI) => {
				api = pi;
			},
			createContextEngine({
				stats,
				hiddenCustomTypes: [UNSENT],
				...options,
				log: (line: string) => {
					if (line.includes("silent truncation") || line.includes("cut #") || line.includes("exact repeat"))
						rows.push({ s: stats.calibrationSamples.length, call: calls, line });
				},
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const counter = new KindCounter(O200K, scales);
	const sim = installProviderSim(harness, {
		tokenizer: "o200k",
		counter,
		limit: window,
		mode: "reject",
		errorStyle: "anthropic",
		observe: (call) => {
			calls++;
			if (reporter === "round100") call.processed = Math.round(call.processed / 100) * 100;
		},
	});
	const model = scriptedModel(harness);
	// Each answer's text, by the provider call it answers (rejected calls get none).
	const answered = new Map<number, string>();
	const answer = (text: string, make: () => ReturnType<typeof fauxAssistantMessage>) => () => {
		answered.set(sim.calls.length - 1, text);
		return make();
	};
	const resends: Array<{
		route: "unsent" | "branch";
		call: number;
		of: number;
		atMaximum: boolean;
		reported: number;
		again: number;
	}> = [];
	const served = (i: number) => !sim.calls[i].rejected && answered.has(i);
	const highestServed = () => Math.max(...sim.calls.filter((_c, i) => served(i)).map((c) => c.processed));
	let n = 0;
	for (let p = 0; p < PROMPTS; p++) {
		const start = sim.calls.length;
		for (let t = 0; t < CALLS; t++) {
			const name = `b${n++}`;
			const text = `Reading ${name}.`;
			model.push(
				answer(text, () =>
					fauxAssistantMessage([fauxText(text), fauxToolCall("blob", { name }, { id: `call-${name}` })], {
						stopReason: "toolUse",
					}),
				),
			);
		}
		// The prompt's last answer is empty, which Pi's converter skips: it sends nothing.
		model.push(answer("", () => fauxAssistantMessage("")));
		await harness.session.prompt(`Go through the material, part ${p}.`);
		// The first resend, by the route a real session takes: an entry that isn't sent triggers a turn, so that
		// request is the last one again, append-only with nothing appended.
		const last = sim.calls.length - 1;
		if (served(last)) {
			const highest = highestServed();
			model.push(answer(`Part ${p} done.`, () => fauxAssistantMessage(`Part ${p} done.`)));
			api!.sendMessage(
				{ customType: UNSENT, content: "A reminder for the host, not sent.", display: false },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();
			const again = sim.calls.length - 1;
			resends.push({
				route: "unsent",
				call: again,
				of: last,
				atMaximum: sim.calls[last].processed === highest,
				reported: sim.calls[last].processed,
				again: sim.calls[again].processed,
			});
		}
		// The second: one request of this prompt sent again from the same point, the one that set the largest usage
		// reported so far or one at random. When the engine has cut since, what it sends differs.
		const mine = Array.from({ length: sim.calls.length - start }, (_, k) => start + k).filter(
			(i) => served(i) && answered.get(i) !== "",
		);
		if (mine.length === 0) continue;
		const highest = highestServed();
		const top = mine.find((i) => sim.calls[i].processed === highest);
		const of = top !== undefined && pick() < 0.8 ? top : mine[int(pick, 0, mine.length - 1)];
		model.push(answer(`Part ${p} resent.`, () => fauxAssistantMessage(`Part ${p} resent.`)));
		await resendAnswered(harness, answered.get(of)!);
		const again = sim.calls.length - 1;
		resends.push({
			route: "branch",
			call: again,
			of,
			atMaximum: sim.calls[of].processed === highest,
			reported: sim.calls[of].processed,
			again: sim.calls[again].processed,
		});
	}
	harness.cleanup();
	harnesses.pop();
	return {
		mix,
		window,
		seed,
		reporter,
		options,
		corpus: process.env.E2_CORPUS_REV,
		kindScale: Object.fromEntries(kindScale),
		kinds: used,
		calls: sim.calls.length,
		// Each call's reported usage and each request's estimate, to compare two runs call for call.
		reported: sim.calls.map((c) => (c.rejected ? null : c.processed)),
		estimates: stats.sent.map((x) => x.estimate),
		rejected: sim.calls.filter((c) => c.rejected).length,
		samples: stats.calibrationSamples.length,
		growthChecks: stats.growthChecks.length,
		cuts: stats.cuts.length,
		detections: stats.plateaus,
		// Only resends that reported the same count as the request they repeat are the shape the guard is for.
		resends: resends.filter((x) => x.reported === x.again),
		resendsDiffering: resends.filter((x) => x.reported !== x.again).length,
		firstDetection: rows.find((row) => row.line.includes("window ->"))?.call ?? null,
		ms: Math.round(performance.now() - started),
		tokenizerMs: Math.round(counter.ms),
		tokenizerCalls: counter.calls,
		scaledCounts: counter.scaled,
		unscaled: counter.unscaled,
		tokenizerChars: counter.chars,
		rows,
	};
}

/** The guarded shape in a session's rows: "not judged" repeats of exactly the maximum, expected below it. */
function guarded(rows: Row[]): number {
	let n = 0;
	for (const { line } of rows) {
		const m = line.match(
			/exact repeat not judged: reported exactly the previous maximum (\d+) again.*expected about (\d+)/,
		);
		if (m && Number(m[2]) < Number(m[1])) n++;
	}
	return n;
}

/** One part of the Power count, as a full run writes it under HONEST_OUT (power.<from>-<to>.json). */
interface PowerPart {
	from: number;
	to: number;
	mixes: string[];
	windows: number[];
	corpus?: string;
	total: number;
	sessions: number;
	of: number;
}

/** The Power parts under `dir` and its folders, one level down (a full run is split by corpus). */
function powerParts(dir: string): Array<PowerPart & { file: string }> {
	const parts: Array<PowerPart & { file: string }> = [];
	const scan = (d: string, depth: number) => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			if (statSync(path).isDirectory()) {
				if (depth === 0) scan(path, 1);
			} else if (/^power\.\d+-\d+\.json$/.test(name))
				parts.push({ ...(JSON.parse(readFileSync(path, "utf8")) as PowerPart), file: path });
		}
	};
	if (existsSync(dir)) scan(dir, 0);
	return parts;
}

describe(`0.9.0, ADR 0035: the detector on honest content${FULL ? ", full run" : ", the CI slice"}`, () => {
	// The baseline's guarded repeats per session (exact reporter), for the Power count.
	const power: number[] = [];
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	if (POWER_SUM) {
		// The bar on the whole full run: every seed from 0 to 49 once, over all three mixes and both windows.
		it("Power, summed over the full run's parts: at least 20 guarded repeats in at least 10 sessions", () => {
			const parts = powerParts(OUT);
			const seeds = parts.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i));
			const whole = parts.every((p) => p.mixes.length === 3 && p.windows.length === 2);
			const covered = seeds.length === 50 && new Set(seeds).size === 50 && seeds.every((n) => n >= 0 && n <= 49);
			const total = parts.reduce((a, p) => a + p.total, 0);
			const sessions = parts.reduce((a, p) => a + p.sessions, 0);
			const line = `Power: ${total} in ${sessions} sessions (of ${parts.reduce((a, p) => a + p.of, 0)}), from ${parts.length} part(s): ${parts.map((p) => `${p.from}-${p.to}${p.corpus ? ` on ${p.corpus}` : ""}`).join(", ")}`;
			writeFileSync(join(OUT, "power.txt"), `${line}\n`);
			process.stderr.write(`${line}\n`);
			expect(covered && whole, `the parts cover seeds 0 to 49 once, all mixes and windows: ${line}`).toBe(true);
			expect(total, line).toBeGreaterThanOrEqual(20);
			expect(sessions, line).toBeGreaterThanOrEqual(10);
		});
		return;
	}
	if (FULL) {
		const asked = process.env.E2_CORPUS_REV;
		if (!asked || asked === "worktree" || resolveRev(asked) === HELD_OUT)
			throw new Error(
				"HONEST_DETECTION: set E2_CORPUS_REV to the v1.4.0, v1.5.0 or v1.5.1 corpus (v1.6.0 is held out)",
			);
		mkdirSync(OUT, { recursive: true });
	}
	for (const reporter of REPORTERS)
		for (const mix of MIXES)
			for (const window of WINDOWS)
				for (const seed of SEEDS)
					it(
						`${mix}, ${window}, seed ${seed}${reporter === "exact" ? "" : `, ${reporter}`}`,
						{ timeout: 1_800_000 },
						async () => {
							let baseline: number | null = null;
							for (const [name, options] of Object.entries(VARIANTS)) {
								const result = await session(mix, window, seed, options, harnesses, reporter);
								if (FULL)
									writeFileSync(
										join(
											OUT,
											`${mix}.${window}.${String(seed).padStart(2, "0")}${reporter === "exact" ? "" : `.${reporter}`}.${name}.json`,
										),
										JSON.stringify({ variant: name, ...result }),
									);
								// A rounding provider is recorded, not failed (the header).
								if (reporter !== "exact") continue;
								// Safety: the shipped engine detects nothing on an honest provider, and a candidate detects only
								// where it does, and not earlier. Soft, so a full run records every session.
								if (name === BASELINE) {
									baseline = result.firstDetection;
									power.push(guarded(result.rows));
									expect.soft(result.detections, `${name}: a detection on an honest provider`).toEqual([]);
								} else if (result.firstDetection !== null)
									expect
										.soft(
											baseline !== null && result.firstDetection >= baseline,
											`${name}: detects at call ${result.firstDetection}, the baseline ${baseline ?? "never"}`,
										)
										.toBe(true);
							}
						},
					);
	// Power for the exact repeat's guard, counted from the logged rows: the full run must meet the guarded shape at
	// least 20 times in at least 10 sessions; the CI slice at least once, so a broken guard can't pass it.
	it("Power: the shipped engine meets the guarded exact repeat", () => {
		const total = power.reduce((a, b) => a + b, 0);
		const sessions = power.filter((n) => n > 0).length;
		const line = `Power: ${total} in ${sessions} sessions (of ${power.length})`;
		if (FULL) {
			// The bar is for the whole run, 300 sessions. A run split by HONEST_SEEDS (one corpus per seed range) writes
			// its part, and HONEST_POWER_SUM=1 adds the parts up and asserts it.
			const part: PowerPart = {
				from,
				to: to ?? from,
				mixes: MIXES,
				windows: WINDOWS,
				corpus: process.env.E2_CORPUS_REV,
				total,
				sessions,
				of: power.length,
			};
			writeFileSync(join(OUT, `power.${part.from}-${part.to}.json`), `${JSON.stringify(part)}\n`);
			writeFileSync(join(OUT, `power.${part.from}-${part.to}.txt`), `${line}\n`);
			process.stderr.write(`${line}\n`);
		} else expect(total, line).toBeGreaterThanOrEqual(1);
	});
});
