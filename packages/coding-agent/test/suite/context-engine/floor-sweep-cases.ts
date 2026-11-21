/**
 * The floor sweep's texts (floor-sweep.test.ts): honest tool output that the engine's estimate can overcount, built
 * from a seeded generator so every run builds the same texts.
 * - Generated: periods of 1 to 8 characters drawn from every ASCII character (control characters, whitespace,
 *   punctuation, letters and digits) and common non-ASCII ones (box drawing, block elements, symbols, emoji, CJK,
 *   Hangul, accented and combining marks, invisible spaces), each repeated to 1,000, 10,000 and 100,000 characters
 *   in five layouts: alone, one per line with LF, one per line with CRLF, numbered lines, and timestamped CRLF lines.
 * - Lines of only a comment, quote or table marker between random blank lines, and runs of 1 to 64 of one non-ASCII
 *   character (ellipsis, dashes, box drawing, blocks, dots, CJK, emoji) between random whitespace and breaks.
 * - Markers after text on the same line, drawn markers of 1 to 8 punctuation and symbol characters, markers with
 *   short punctuation after them, and markers and closing brackets followed by a break and indentation.
 * - Named: the cases the reviews of 0.8.0 and the floor's own measurements found (test reporters, rules, bars, base64
 *   and hex of zero, sparse and random data, blank and whitespace lines, tables, logs, data, CJK, emoji, source).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface SweepCase {
	name: string;
	text: () => string;
}

/** mulberry32. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ASCII = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));
const OTHER = [
	..."─│┌┐└┘├┤┬┴┼═║╔╗╚╝█▓▒░▀▄▌▐■□●○•…→←✓✔✗✘",
	"😀",
	"🚀",
	"✅",
	"❌",
	"⚠️",
	"🎉",
	"🔥",
	..."中文日本語한국어",
	"é",
	"é",
	"̀",
	"​",
	" ",
	"　",
];
const POOL = [...ASCII, ...OTHER];
const WHITE = [...Array.from({ length: 33 }, (_, i) => String.fromCharCode(i)), "\x7f", " ", "　"];
const PUNCT = ASCII.filter((c) => /[!-/:-@[-`{-~]/.test(c));

/**
 * The repeated units: every character alone; for each period from 2 to 8, 24 drawn from all characters, 8 from
 * whitespace and control characters and 8 from punctuation; and named whitespace periods (blank CRLF lines, lines of
 * one tab or one space, and mixes).
 */
export function sweepUnits(seed = 805): string[] {
	const r = rng(seed);
	const pick = (pool: string[], p: number) =>
		Array.from({ length: p }, () => pool[Math.floor(r() * pool.length)]).join("");
	const out = [...POOL];
	for (let p = 2; p <= 8; p++) {
		for (let k = 0; k < 24; k++) out.push(pick(POOL, p));
		for (let k = 0; k < 8; k++) out.push(pick(WHITE, p));
		for (let k = 0; k < 8; k++) out.push(pick(PUNCT, p));
	}
	out.push("\r\n", "\t\n", " \n", "\t\r\n", " \r\n", "\r\n\r\n\r\n\t", "  \n", "\n\n\t");
	// Periods 9 to 32, from a generator of their own: 6 from whitespace and control, 2 from whitespace and
	// punctuation, 2 from all characters.
	const r2 = rng(seed + 32);
	const pick2 = (pool: string[], p: number) =>
		Array.from({ length: p }, () => pool[Math.floor(r2() * pool.length)]).join("");
	for (let p = 9; p <= 32; p++) {
		for (let k = 0; k < 6; k++) out.push(pick2(WHITE, p));
		for (let k = 0; k < 2; k++) out.push(pick2([...WHITE, ...PUNCT], p));
		for (let k = 0; k < 2; k++) out.push(pick2(POOL, p));
	}
	return [...new Set(out)];
}

const LAYOUTS: Record<string, (unit: string, size: number) => string> = {
	alone: (u, size) => u.repeat(Math.ceil(size / u.length)).slice(0, size),
	"per line LF": (u, size) => `${u}\n`.repeat(Math.ceil(size / (u.length + 1))).slice(0, size),
	"per line CRLF": (u, size) => `${u}\r\n`.repeat(Math.ceil(size / (u.length + 2))).slice(0, size),
	"numbered lines": (u, size) => {
		let s = "";
		for (let i = 1; s.length < size; i++) s += `${i}: ${u}\n`;
		return s.slice(0, size);
	},
	"timestamped CRLF lines, unit repeated": (u, size) => {
		let s = "";
		const body = u.repeat(Math.max(1, Math.ceil(40 / u.length)));
		for (let i = 0; s.length < size; i++)
			s += `2026-11-13T10:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")} ${body}\r\n`;
		return s.slice(0, size);
	},
};

export const SWEEP_SIZES = [1_000, 10_000, 100_000];

/** The generated cases, for the given sizes. */
export function generatedCases(sizes = SWEEP_SIZES): SweepCase[] {
	const cases: SweepCase[] = [];
	for (const u of sweepUnits())
		for (const [layout, make] of Object.entries(LAYOUTS))
			for (const size of sizes)
				cases.push({ name: `${JSON.stringify(u)} ${layout} ${size}`, text: () => make(u, size) });
	return cases;
}

/** Unicode spaces besides space and tab: NBSP, the U+2000 block, narrow NBSP, medium mathematical space, ideographic. */
const USPACES = [
	"\u00a0",
	..."\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a",
	"\u202f",
	"\u205f",
	"\u3000",
];
/** The mixes whitespace stretches are drawn from. */
const MIXES: Record<string, string[]> = {
	LF: ["\n"],
	CRLF: ["\r\n"],
	CR: ["\r"],
	"LF and CRLF": ["\n", "\r\n"],
	"space and LF": [" ", "\n"],
	"tab and LF": ["\t", "\n"],
	"space, tab and CRLF": [" ", "\t", "\r\n"],
	"space, tab, CR and LF": [" ", "\t", "\r", "\n"],
	"NBSP and LF": ["\u00a0", "\n"],
	"Unicode spaces and LF": [...USPACES, "\n"],
	"VT, FF and LF": ["\v", "\f", "\n"],
	"all whitespace": [" ", "\t", "\r", "\n", "\v", "\f", ...USPACES],
};
const BREAK = /[\r\n]/;

/** A text line of 1 to 80 characters: words, numbers and a little punctuation. */
function textLine(r: () => number): string {
	const words = [
		"ok",
		"INFO",
		"test",
		"passed",
		"x",
		"value",
		"=",
		"42",
		"src/main.ts",
		"done",
		"->",
		"[1/3]",
		"line",
	];
	const want = 1 + Math.floor(r() * 80);
	let s = "";
	while (s.length < want) s += `${s ? " " : ""}${words[Math.floor(r() * words.length)]}`;
	return s.slice(0, want);
}

/**
 * Whitespace that holds a newline, between varying lines, in three families:
 * - stretches of every length from 1 to 64 code units, of each mix, periodic (a unit repeated) or random, after a
 *   counter line or a text line of 1 to 80 characters;
 * - aperiodic lines: random trailing whitespace, random indentation, random blank-line counts;
 * each about `size` characters.
 */
export function whitespaceCases(size = 4_000): SweepCase[] {
	const cases: SweepCase[] = [];
	for (const [mixName, mix] of Object.entries(MIXES))
		for (let length = 1; length <= 64; length++)
			for (const kind of ["periodic", "random"] as const)
				for (const head of ["counter", "text"] as const) {
					const seed = 1_000_003 * length + 7 * kind.length + head.length + mixName.length * 31;
					cases.push({
						name: `${length} units of ${mixName}, ${kind}, after ${head} lines`,
						text: () => {
							const r = rng(seed);
							const draw = () => mix[Math.floor(r() * mix.length)];
							let unit = "";
							while (unit.length < Math.max(1, Math.min(length, 1 + Math.floor(r() * 8)))) unit += draw();
							const stretch = () => {
								let w = "";
								if (kind === "periodic") while (w.length < length) w += unit;
								else while (w.length < length) w += draw();
								w = w.slice(0, length);
								if (!BREAK.test(w)) w = mix.some((c) => BREAK.test(c)) ? `${w.slice(0, -1)}\n` : `${w}\n`;
								return w;
							};
							let s = "";
							for (let i = 0; s.length < size; i++) s += `${head === "counter" ? i : textLine(r)}${stretch()}`;
							return s;
						},
					});
				}
	const eols: Record<string, (r: () => number) => string> = {
		LF: () => "\n",
		CRLF: () => "\r\n",
		CR: () => "\r",
		mixed: (r) => ["\n", "\r\n", "\r"][Math.floor(r() * 3)],
	};
	const fill = (seed: number, line: (r: () => number, i: number) => string) => () => {
		const r = rng(seed);
		let s = "";
		for (let i = 0; s.length < size; i++) s += line(r, i);
		return s;
	};
	for (const seed of [1, 2, 3])
		for (const [eolName, eol] of Object.entries(eols)) {
			for (const most of [1, 2, 4, 8, 16, 32])
				for (const chars of ["spaces", "spaces and tabs"])
					for (const body of ["blank", "text"] as const)
						cases.push({
							name: `${body} lines, 0 to ${most} trailing ${chars}, ${eolName}, seed ${seed}`,
							text: fill(seed * 97 + most, (r, _i) => {
								const pool = chars === "spaces" ? [" "] : [" ", "\t"];
								const n = Math.floor(r() * (most + 1));
								const tail = Array.from({ length: n }, () => pool[Math.floor(r() * pool.length)]).join("");
								return `${body === "text" ? textLine(r) : ""}${tail}${eol(r)}`;
							}),
						});
			for (let depth = 1; depth <= 8; depth++)
				for (const indent of ["  ", "    ", "\t"])
					for (const body of ["blank", "text"] as const)
						cases.push({
							name: `${body} lines indented 0 to ${depth} x ${JSON.stringify(indent)}, ${eolName}, seed ${seed}`,
							text: fill(seed * 89 + depth, (r) => {
								const pad = indent.repeat(Math.floor(r() * (depth + 1)));
								return `${pad}${body === "text" ? textLine(r) : ""}${eol(r)}`;
							}),
						});
			for (let most = 1; most <= 20; most++)
				for (const blanks of ["empty", "with trailing whitespace"])
					cases.push({
						name: `text lines with 0 to ${most} blank lines ${blanks} between, ${eolName}, seed ${seed}`,
						text: fill(seed * 83 + most, (r) => {
							let s = `${textLine(r)}${eol(r)}`;
							const n = Math.floor(r() * (most + 1));
							for (let k = 0; k < n; k++)
								s += `${blanks === "empty" ? "" : " \t".slice(0, Math.floor(r() * 3))}${eol(r)}`;
							return s;
						}),
					});
		}
	return cases;
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const repo = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

/** The named cases. */
export function namedCases(): SweepCase[] {
	const r = rng(12345);
	const rint = (n: number) => Math.floor(r() * n);
	const bytes = (n: number, f: (i: number) => number) => Buffer.from(Array.from({ length: n }, (_, i) => f(i) & 255));
	const sparse = (d: number, n: number) => bytes(n, () => (r() < d ? rint(256) : 0));
	const hexdump = (b: Buffer) =>
		lines(Math.ceil(b.length / 16), (i) => {
			const row = b.subarray(i * 16, i * 16 + 16);
			const hx = Array.from(row, (x) => x.toString(16).padStart(2, "0"))
				.join("")
				.replace(/(.{4})/g, "$1 ")
				.trim();
			return `${(i * 16).toString(16).padStart(8, "0")}: ${hx.padEnd(39)}  ${Array.from(row, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("")}`;
		});
	const cell = (t: string, w: number) => ` ${t}${" ".repeat(Math.max(0, w - t.length))} `;
	const unittest = (t: number) => `${".".repeat(t)}\n${"-".repeat(70)}\nRan ${t} tests in 41.512s\n\nOK\n`;
	const pytest = (files: number, tests: number) =>
		`${"=".repeat(30)} test session starts ${"=".repeat(29)}\ncollected ${files * tests} items\n\n${lines(files, (i) => `tests/test_mod_${i}.py ${".".repeat(tests)} [${String(Math.round(((i + 1) * 100) / files)).padStart(3)}%]`)}\n\n${"=".repeat(28)} ${files * tests} passed in 12.34s ${"=".repeat(28)}\n`;
	const source = repo("packages/coding-agent/src/core/agent-session.ts");
	const hash = createHash("sha256").update("x").digest("hex");
	const named: Array<[string, string]> = [
		["unittest, 2,000 tests", unittest(2_000)],
		["unittest, 600 tests", unittest(600)],
		[
			"RSpec progress, 1,500 examples",
			`${lines(15, () => ".".repeat(100))}\n\nFinished in 4.2 seconds\n1500 examples, 0 failures\n`,
		],
		[
			"80-character = rules between short lines",
			lines(40, (i) => (i % 2 ? "=".repeat(80) : `Step ${i}: building lib_${i}`)),
		],
		[
			"curl-style # bars",
			lines(
				40,
				(i) =>
					`${"#".repeat(Math.round((i + 1) * 1.75))}${" ".repeat(70 - Math.round((i + 1) * 1.75))} ${((i + 1) * 2.5).toFixed(1)}%`,
			),
		],
		["pytest -q, 4,000 tests", `${lines(50, () => `${".".repeat(80)} [ 50%]`)}\n4000 passed in 30.11s\n`],
		["pytest, 60 files x 120 tests", pytest(60, 120)],
		["pytest, 40 files x 60 tests", pytest(40, 60)],
		[
			"git diff --stat, 80 files",
			`${lines(80, (i) => ` src/module_${i}/handler_${i}.ts | ${String(10 + ((i * 7) % 90)).padStart(3)} ${"+".repeat(10 + ((i * 7) % 40))}${"-".repeat((i * 3) % 20)}`)}\n 80 files changed, 2140 insertions(+), 612 deletions(-)\n`,
		],
		["base64 of 3,000 zero bytes", Buffer.alloc(3_000).toString("base64")],
		[
			"base64 of sparse binary",
			bytes(3_000, (i) => (i % 97 === 0 ? i * 7 : i % 41 === 0 ? 1 : 0)).toString("base64"),
		],
		["60 lines of -= x35", lines(60, () => "-=".repeat(35))],
		["60 lines of x x70", lines(60, () => "x".repeat(70))],
		["a report ruled with -=-= lines", lines(30, (i) => `section ${i}\n${"-=".repeat(35)}`)],
		["1,500 blank CRLF lines", `Output:\r\n${"\r\n".repeat(1_500)}Done.\r\n`],
		["1,500 lines of one tab", `${"\t\n".repeat(1_500)}`],
		["1,500 lines of one space", `${" \n".repeat(1_500)}`],
		["1,500 blank LF lines", `Output:\n${"\n".repeat(1_500)}Done.\n`],
		[
			"a CRLF log with three blank lines after each entry",
			Array.from({ length: 300 }, (_, i) => `entry ${i} ok\r\n\r\n\r\n\r\n`).join(""),
		],
		["the same hash on 100 lines", lines(100, () => hash)],
		["4,000 spaces then a word", `${" ".repeat(4_000)}end`],
		["40,000 spaces then a word", `${" ".repeat(40_000)}end`],
		["lines padded with 200 spaces", lines(100, (i) => `col ${i}${" ".repeat(200)}|`)],
		["base64 of random bytes", bytes(3_000, () => rint(256)).toString("base64")],
		["hex of random bytes", bytes(2_000, () => rint(256)).toString("hex")],
		["xxd of zero bytes", hexdump(Buffer.alloc(2_048))],
		["xxd of random bytes", hexdump(bytes(2_048, () => rint(256)))],
		[
			"ASCII table, +---+ rules between rows",
			lines(
				40,
				(i) => `+${"-".repeat(22)}+${"-".repeat(12)}+\n|${cell(`package-${i}`, 20)}|${cell(`1.${i}.0`, 10)}|`,
			),
		],
		[
			"box-drawing table with rules between rows",
			lines(
				40,
				(i) => `│${cell(`row ${i}`, 20)}│${cell(String(i * 37), 10)}│\n├${"─".repeat(22)}┼${"─".repeat(12)}┤`,
			),
		],
		["tree output", lines(200, (i) => `${"│   ".repeat(i % 5)}${i % 3 ? "├── " : "└── "}file-${i}.ts`)],
		[
			"ANSI coloured test output",
			lines(150, (i) => `\x1b[32m✓\x1b[0m \x1b[2mtest ${i} passes\x1b[22m \x1b[90m(${rint(90)}ms)\x1b[39m`),
		],
		["spinner frames", lines(200, (i) => `${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[i % 10]} Installing dependencies... ${i}/200`)],
		["CSV of numbers", `t,x,y\n${lines(300, (i) => `${i},${(r() * 1000).toFixed(3)},${rint(100000)}`)}`],
		["CSV of zeros", `a,b,c,d\n${lines(300, () => "0,0,0,0")}`],
		[
			"JSON of sha256 hashes",
			JSON.stringify(
				Object.fromEntries(
					Array.from({ length: 120 }, (_, i) => [
						`file_${i}.ts`,
						createHash("sha256").update(String(i)).digest("hex"),
					]),
				),
				null,
				2,
			),
		],
		[
			"log with timestamps",
			lines(
				150,
				(i) =>
					`2026-11-12T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z INFO request path=/api/v1/items/${rint(10000)} status=200 ms=${rint(300)}`,
			),
		],
		["log, one line repeated", lines(150, () => "WARN deprecated option --legacy-peer-deps, use --strict-peer-deps")],
		[
			"long paths",
			lines(
				120,
				(i) =>
					`/workspace/project/packages/module-${i % 7}/src/components/deeply/nested/level-${i}/file-${i}.test.ts`,
			),
		],
		["emoji lines", lines(80, (i) => `${["✅", "🚀", "🔥", "⚠️", "❌"][i % 5]} step ${i} ${"🎉".repeat(i % 6)}`)],
		["emoji run", "😀".repeat(2_000)],
		["TypeScript source, 16,000 characters", source.slice(0, 16_000)],
		["TypeScript source, a whole file", source],
		["package-lock.json, 16,000 characters", repo("package-lock.json").slice(40_000, 56_000)],
		["README.md, 16,000 characters", repo("README.md").slice(0, 16_000)],
	];
	for (let d = 1; d <= 41; d += 2)
		for (const n of [3_000, 30_000]) {
			const b = sparse(d / 100, n);
			named.push([`base64 of ${n} bytes, ${d}% set`, b.toString("base64")]);
			named.push([`base64 -w76 of ${n} bytes, ${d}% set`, b.toString("base64").replace(/(.{76})/g, "$1\n")]);
			named.push([`hex of ${n} bytes, ${d}% set`, b.toString("hex")]);
		}
	return named.map(([name, text]) => ({ name, text: () => text }));
}

/**
 * The second recheck's cases (its round-two measurements, then its sessions 9 to 13), built with its own generator in
 * its own order, so the texts are the ones it measured.
 */
export function recheckCases(): SweepCase[] {
	const source = repo("packages/coding-agent/src/core/agent-session.ts");
	let seed = 987654321;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	const join = (n: number, f: (i: number) => string, eol = "\n") =>
		Array.from({ length: n }, (_, i) => f(i)).join(eol);
	const measured: Array<[string, () => string]> = [
		["14 blank CRLF lines after each entry", () => join(150, (i) => `ok ${i}\r\n${"\r\n".repeat(14)}`, "")],
		["15 blank CRLF lines after each entry", () => join(150, (i) => `ok ${i}\r\n${"\r\n".repeat(15)}`, "")],
		["7 tab lines after each entry", () => join(300, (i) => `ok ${i}\n${"\t\n".repeat(7)}`, "")],
		["10 space lines after each entry", () => join(300, (i) => `${i}\n${" \n".repeat(10)}`, "")],
		["random LF/CRLF blank lines", () => Array.from({ length: 2000 }, () => pick(["\n", "\r\n"])).join("")],
		["random LF/CRLF/CR blank lines", () => Array.from({ length: 2000 }, () => pick(["\n", "\r\n", "\r"])).join("")],
		[
			"blank lines, 0-6 random trailing spaces",
			() => Array.from({ length: 1500 }, () => `${" ".repeat(Math.floor(rnd() * 7))}\n`).join(""),
		],
		[
			"blank lines, random tabs and spaces, CRLF",
			() =>
				Array.from(
					{ length: 1500 },
					() => `${Array.from({ length: Math.floor(rnd() * 5) }, () => pick([" ", "\t"])).join("")}\r\n`,
				).join(""),
		],
		[
			"random whitespace soup (sp tab LF CR VT FF)",
			() => Array.from({ length: 4000 }, () => pick([" ", "\t", "\n", "\r", "\v", "\f"])).join(""),
		],
		[
			"random LF/tab-LF/space-LF lines",
			() => Array.from({ length: 2000 }, () => pick(["\n", "\t\n", " \n", "\r\n"])).join(""),
		],
		["9 tabs + CRLF lines (period 11)", () => "\t\t\t\t\t\t\t\t\t\r\n".repeat(400)],
		["10 tabs + LF lines (period 11)", () => "\t\t\t\t\t\t\t\t\t\t\n".repeat(400)],
		["12 spaces + CRLF lines (period 14)", () => `${" ".repeat(12)}\r\n`.repeat(400)],
		["CRLF x5 + tab (period 11)", () => "\r\n\r\n\r\n\r\n\r\n\t".repeat(400)],
		["CRLF x6 + tab CRLF (period 15)", () => "\r\n\r\n\r\n\r\n\r\n\r\n\t\r\n".repeat(300)],
		["period 13 punct+ws", () => "-- \r\n\t\r\n;; \r\n\r\n".repeat(300)],
		["period 24 whitespace", () => "\r\n\t\r\n \r\n\t\t\r\n  \r\n\r\n\t\r\n\r\n\r\n".repeat(150)],
		["CRLF blank lines with a counter every 8", () => join(400, (i) => `${i}${"\r\n".repeat(8)}`, "")],
		["tab lines with varying tab count", () => join(1500, (i) => "\t".repeat(1 + (i % 7)), "\r\n")],
		[
			"indented blank lines in Python (varying depth)",
			() =>
				join(
					600,
					(i) => (i % 3 === 0 ? `${"    ".repeat(1 + (i % 4))}x_${i} = ${i}` : "    ".repeat(1 + (i % 5))),
					"\n",
				),
		],
		[
			"source code with CRLF and doubled blank lines",
			() =>
				source
					.slice(0, 30_000)
					.replace(/\n/g, "\r\n")
					.replace(/\r\n\r\n/g, "\r\n\r\n\r\n\r\n"),
		],
		["decomposed é repeated", () => "e\u0301".repeat(3000)],
		[
			"zalgo combining stacks",
			() =>
				Array.from(
					{ length: 1500 },
					() =>
						`a${Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => String.fromCharCode(0x300 + Math.floor(rnd() * 0x6f))).join("")}`,
				).join(""),
		],
		["NFD Vietnamese text repeated lines", () => join(300, () => "Tiếng Việt có dấu".normalize("NFD"))],
		[
			"ideographic spaces and LF random",
			() => Array.from({ length: 2000 }, () => pick(["\u3000", "\n", "\u3000\n"])).join(""),
		],
		["NBSP/LF random", () => Array.from({ length: 2000 }, () => pick(["\u00a0", "\n", " "])).join("")],
		[
			"zero-width spaces random with LF",
			() => Array.from({ length: 3000 }, () => pick(["\u200b", "\n", "\u200b\u200b"])).join(""),
		],
		[
			"one 60k line of random '. ' and '.  '",
			() => Array.from({ length: 20000 }, () => pick([". ", ".  ", ". . "])).join(""),
		],
		["one 60k line random box chars", () => Array.from({ length: 30000 }, () => pick(["─", "│", "┼", " "])).join("")],
		[
			"one 30k line random whitespace+punct",
			() => Array.from({ length: 30000 }, () => pick([" ", "\t", ".", ",", ";"])).join(""),
		],
		[
			"random control bytes (latin1 binary, 30% NUL)",
			() =>
				Array.from({ length: 6000 }, () =>
					rnd() < 0.3 ? "\u0000" : String.fromCharCode(1 + Math.floor(rnd() * 31)),
				).join(""),
		],
		[
			"random NUL/0x01/0x02 binary",
			() => Array.from({ length: 6000 }, () => pick(["\u0000", "\u0001", "\u0002"])).join(""),
		],
		["random NUL/LF", () => Array.from({ length: 6000 }, () => pick(["\u0000", "\n"])).join("")],
		["random LF/CR/ESC", () => Array.from({ length: 6000 }, () => pick(["\n", "\r", "\u001b"])).join("")],
		[
			"mixed: CRLF blank runs of random length 1-15",
			() => Array.from({ length: 300 }, (_, i) => `l${i}\r\n${"\r\n".repeat(1 + Math.floor(rnd() * 15))}`).join(""),
		],
	];
	// Built in order, as the recheck built them: the random draws run through one generator.
	const texts = measured.map(([name, f]) => [`recheck: ${name}`, f()] as const);
	seed = 987654321;
	const sessions: Array<[string, string]> = [
		[
			"session 9: a counter line, then 7 blank CRLF lines, 400 times",
			Array.from({ length: 400 }, (_, i) => `${i}${"\r\n".repeat(8)}`).join(""),
		],
		["session 10: CRLF x5 and a tab, 400 times", "\r\n\r\n\r\n\r\n\r\n\t".repeat(400)],
		[
			"session 11: CRLF lines with blank stretches of 1 to 15 lines",
			Array.from({ length: 300 }, (_, i) => `l${i}\r\n${"\r\n".repeat(1 + Math.floor(rnd() * 15))}`).join(""),
		],
		[
			"session 12: 1,500 blank lines with 0 to 6 trailing spaces",
			Array.from({ length: 1500 }, () => `${" ".repeat(Math.floor(rnd() * 7))}\n`).join(""),
		],
		[
			"session 13: 14 blank CRLF lines after each of 150 entries",
			Array.from({ length: 150 }, (_, i) => `ok ${i}\r\n${"\r\n".repeat(14)}`).join(""),
		],
	];
	return [...texts, ...sessions].map(([name, text]) => ({ name, text: () => text }));
}

/**
 * Lines that hold only a marker (comment, quote, table or list punctuation), with no, one or 0 to 3 trailing spaces,
 * between 0 to `most` blank lines drawn at random, LF and CRLF: tokenizers take the marker and the breaks after it as
 * one or two tokens.
 */
const MARKERS = [
	"//",
	"#",
	">",
	"*",
	" *",
	"|",
	"--",
	";",
	"%",
	"##",
	";;",
	"::",
	"/*",
	"*/",
	"-->",
	"'",
	'"',
	"REM",
	"+",
	"=",
	"~",
	"^",
	"@",
	"$",
	"!",
	":",
	">>",
	"%%",
	"-",
	"\\",
	"`",
];

export function markerLineCases(size = 4_000): SweepCase[] {
	const cases: SweepCase[] = [];
	for (const m of MARKERS)
		for (const trail of ["none", "one space", "0-3 spaces"])
			for (const most of [0, 1, 2, 4, 8])
				for (const eol of ["\n", "\r\n"])
					for (const seed of [1, 2])
						cases.push({
							name: `${JSON.stringify(m)} lines, trailing ${trail}, 0 to ${most} blank lines between, ${eol === "\n" ? "LF" : "CRLF"}, seed ${seed}`,
							text: () => {
								const r = rng(seed * 7919 + most * 31 + m.length * 131 + trail.length);
								let s = "";
								while (s.length < size) {
									const t =
										trail === "none" ? "" : trail === "one space" ? " " : " ".repeat(Math.floor(r() * 4));
									s += `${m}${t}${eol}${eol.repeat(Math.floor(r() * (most + 1)))}`;
								}
								return s;
							},
						});
	return cases;
}

/** Runs of 1 to 64 of one non-ASCII character, each followed by random spaces or tabs and 1 to 7 LF or CRLF breaks. */
const NON_ASCII = [
	"…",
	"—",
	"–",
	"‒",
	"─",
	"━",
	"═",
	"│",
	"█",
	"▓",
	"░",
	"▪",
	"·",
	"•",
	"・",
	"‥",
	"。",
	"～",
	"中",
	"😀",
	"🚀",
	"✅",
];

export function nonAsciiRunCases(size = 4_000): SweepCase[] {
	const cases: SweepCase[] = [];
	for (const ch of NON_ASCII)
		for (let length = 1; length <= 64; length++)
			for (const eol of ["\n", "\r\n"])
				cases.push({
					name: `${JSON.stringify(ch)} runs of ${length}, with breaks and whitespace, ${eol === "\n" ? "LF" : "CRLF"}`,
					text: () => {
						const r = rng(length * 104729 + (ch.codePointAt(0) ?? 0) + eol.length);
						let s = "";
						while (s.length < size) {
							const ws = r() < 0.5 ? "" : [" ", "  ", "\t", " \t"][Math.floor(r() * 4)];
							s += `${ch.repeat(length)}${ws}${eol.repeat(1 + Math.floor(r() * 7))}`;
						}
						return s;
					},
				});
	return cases;
}

/**
 * The third recheck's cases (its two rounds of measurements, each from its own generator, then its sessions 14 to
 * 16), built in its order, so the texts are the ones it measured.
 */
export function thirdRecheckCases(): SweepCase[] {
	const src = repo("packages/coding-agent/src/core/agent-session.ts");
	const b64zero = Buffer.alloc(1500).toString("base64");
	const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
	const lcg = (seed: number) => () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	// Built in insertion order: the random draws of a round run through one generator.
	const built = (prefix: string, cases: Record<string, () => string>) =>
		Object.entries(cases).map(([name, f]) => [`${prefix}${name}`, f()] as const);

	let rnd = lcg(24681357);
	let pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	let cases: Record<string, () => string> = {};
	// 1. Near 19 units after counter lines, several mixes, several lengths.
	for (const L of [16, 17, 18, 19, 20, 21, 22, 24]) {
		cases[`counter + ${L} units CRLF-ish (CRLF pairs, odd: +space)`] = () =>
			rep(400, (i) => `${i}${"\r\n".repeat(Math.floor(L / 2))}${L % 2 ? " " : ""}`);
		cases[`counter + ${L} LF`] = () => rep(400, (i) => `${i}${"\n".repeat(L)}`);
		cases[`counter + ${L} units ' \\n'`] = () => rep(400, (i) => `${i}${" \n".repeat(Math.floor(L / 2))}`);
	}
	// 2. Punctuation that merges with the breaks after it.
	for (const p of ["}", ")", ";", ".", "!", ":", "]", ","])
		for (const k of [2, 4, 8, 10]) cases[`'${p}' + ${k} CRLF`] = () => rep(400, () => `${p}${"\r\n".repeat(k)}`);
	for (const k of [3, 6, 9])
		cases[`code close braces + ${k} blank LF lines`] = () =>
			rep(300, (i) => `\t}${"\n".repeat(k)}${i % 2 ? "" : "\t"}`);
	// 3. What "leave out one break and its indentation" lets through.
	for (const sp of [
		["\u3000"],
		["\u00a0"],
		["\u2003"],
		["\u3000", "\u00a0", "\u2003", "\u2009"],
		["\t", " "],
		["\u00a0", " "],
	])
		for (const k of [3, 8, 16, 30])
			cases[`line + break + ${k} indent of ${JSON.stringify(sp.join(""))}`] = () =>
				rep(400, (i) => `x${i % 10}\n${rep(k, () => pick(sp))}`);
	cases["one break + 60 tabs indentation, short lines"] = () => rep(200, () => `x\n${"\t".repeat(60)}`);
	cases["one break + 60 spaces indentation, short lines"] = () => rep(200, () => `x\n${" ".repeat(60)}`);
	cases["CR alone + 20 spaces"] = () => rep(400, (i) => `${i}\r${" ".repeat(20)}`);
	// 4. Unicode line separators and other breaks the arm does not count as breaks.
	for (const [name, set] of [
		["U+2028", ["\u2028"]],
		["U+2029", ["\u2029"]],
		["NEL", ["\u0085"]],
		["VT/FF", ["\u000b", "\u000c"]],
		["U+2028/U+2029/NEL mix", ["\u2028", "\u2029", "\u0085"]],
		["U+2028 + spaces", ["\u2028", " ", " "]],
		["NEL + LF mix", ["\u0085", "\n"]],
		["VT/FF/LF mix", ["\u000b", "\u000c", "\n"]],
		["FEFF/LF mix", ["\ufeff", "\n"]],
	] as [string, string[]][]) {
		cases[`counter + 12 random of ${name}`] = () => rep(400, (i) => `${i}${rep(12, () => pick(set))}`);
		cases[`2000 random of ${name}`] = () => rep(2000, () => pick(set));
	}
	// 5. Whitespace runs broken into pieces by non-whitespace the tokenizer may merge.
	cases["blank lines each holding a ZWSP"] = () => rep(1500, () => (rnd() < 0.5 ? "\u200b\r\n" : "\u200b\n"));
	cases["blank lines each holding a BOM"] = () => rep(1500, () => pick(["\ufeff\r\n", "\ufeff\n"]));
	cases["blank lines each holding a soft hyphen"] = () =>
		rep(1500, () => pick(["\u00ad\r\n", "\u00ad\n", "\u00ad\n\n"]));
	cases["blank lines each holding an ESC[0m"] = () =>
		rep(1000, () => pick(["\u001b[0m\r\n", "\u001b[0m\n\n", "\u001b[0m\n"]));
	cases["blank lines each holding a NUL"] = () => rep(1500, () => pick(["\u0000\r\n", "\u0000\n", "\u0000\n\n"]));
	cases["blank lines each with a lone '>' (quoted email)"] = () =>
		rep(1500, () => pick([">\r\n", ">\n", "> \n", ">\n\n"]));
	cases["blank lines each with '#' (shell comments)"] = () => rep(1500, () => pick(["#\n", "# \n", "#\n\n", "#\r\n"]));
	cases["blank lines each with '//'"] = () => rep(1500, () => pick(["//\n", "// \n", "//\n\n"]));
	cases["blank lines each with '*' (doc comment)"] = () => rep(1500, () => pick([" *\n", " * \n", " *\n\n"]));
	cases["blank lines each with '|' table edges"] = () => rep(1500, () => pick(["|\n", "| |\n", "|\r\n", "|  |\n"]));
	// 6. Mixes of the arms in one append.
	cases["base64 zeros + blank CRLF stretches"] = () =>
		rep(20, (i) => `${b64zero.slice(0, 200)}\r\n${"\r\n".repeat(3 + (i % 9))}`);
	cases["dot runs (8-30) + blank lines"] = () =>
		rep(300, (i) => `${".".repeat(8 + (i % 23))}${"\n".repeat(2 + (i % 5))}`);
	cases["ellipsis runs + blank CRLF"] = () =>
		rep(300, (i) => `${"…".repeat(4 + (i % 12))}${"\r\n".repeat(2 + (i % 6))}`);
	cases["box rules (4-31) + blank lines"] = () =>
		rep(300, (i) => `${"═".repeat(4 + (i % 28))}${"\n".repeat(2 + (i % 4))}`);
	cases["-=-= rules + random blank lines + base64 zeros"] = () =>
		rep(
			100,
			(i) =>
				`${"-=".repeat(10 + (i % 25))}${"\n".repeat(1 + Math.floor(rnd() * 6))}${i % 3 ? "" : b64zero.slice(0, 120)}\n`,
		);
	cases["test dots + CRLF blanks + spaces"] = () =>
		rep(200, (i) => `${".".repeat(5 + (i % 50))}${" ".repeat(i % 5)}${"\r\n".repeat(1 + (i % 7))}`);
	cases["hex zeros spaced + blank lines"] = () =>
		rep(200, (i) => `${"00 ".repeat(8 + (i % 8))}${"\n".repeat(2 + (i % 5))}`);
	// 7. Anything else.
	cases["source with all-blank-line-heavy CRLF and trailing spaces"] = () =>
		src
			.slice(0, 30_000)
			.split("\n")
			.map((l) => `${l}${" ".repeat(Math.floor(rnd() * 4))}${"\r\n".repeat(1 + Math.floor(rnd() * 3))}`)
			.join("");
	cases["markdown with hard-break double spaces"] = () => rep(800, (i) => `word ${i}  \n`);
	cases["csv with empty fields"] = () => rep(800, () => ",,,,,,,,,,,,\r\n");
	cases["tsv of empty fields"] = () => rep(800, () => "\t\t\t\t\t\t\t\t\t\t\t\r\n");
	cases["random whitespace soup incl Unicode separators"] = () =>
		rep(4000, () => pick([" ", "\t", "\n", "\r", "\u2028", "\u0085", "\u00a0", "\u3000"]));
	cases["JSON pretty-printed empty arrays"] = () => rep(300, (i) => `${"  ".repeat(1 + (i % 6))}"k${i}": [],\n`);
	cases["YAML of empty values"] = () => rep(600, (i) => `${"  ".repeat(i % 5)}k${i}:\n`);
	cases["diff of whitespace-only changes"] = () => rep(400, (i) => `-${" ".repeat(i % 9)}\n+${"\t".repeat(i % 4)}\n`);

	const first = built("third recheck: ", cases);

	rnd = lcg(24681357);
	pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	cases = {};
	const marks = [
		"//",
		"--",
		"##",
		"#",
		"%",
		"%%",
		";;",
		"::",
		"'",
		'"""',
		"*",
		" *",
		"/*",
		"-->",
		"!",
		"REM",
		">",
		">>",
		"|",
		"+",
		"=",
		"~",
		"^",
		"@",
		"$",
	];
	for (const m of marks) {
		cases[`random mix of '${m}' lines`] = () => rep(1500, () => pick([`${m}\n`, `${m} \n`, `${m}\n\n`]));
		cases[`random mix of '${m}' lines CRLF`] = () =>
			rep(1500, () => pick([`${m}\r\n`, `${m} \r\n`, `${m}\r\n\r\n`, `${m}\r\n\r\n\r\n`]));
		cases[`'${m}' + random 0-3 spaces + LF`] = () => rep(1500, () => `${m}${" ".repeat(Math.floor(rnd() * 4))}\n`);
	}
	for (const ch of ["…", "—", "─", "═", "・", "‥", "·", "•", "。", "～", "‒", "━", "▪", "█", "░"])
		for (const [eol, nm] of [
			["\n", "LF"],
			["\r\n", "CRLF"],
		])
			cases[`'${ch}' runs 4-31 + 2-7 ${nm} breaks`] = () =>
				rep(300, () => `${ch.repeat(4 + Math.floor(rnd() * 28))}${eol.repeat(2 + Math.floor(rnd() * 6))}`);
	cases["ellipsis runs + blank CRLF (as round 3)"] = () =>
		rep(300, (i) => `${"…".repeat(4 + (i % 12))}${"\r\n".repeat(2 + (i % 6))}`);
	cases["ellipsis 4-8 + 2-3 CRLF"] = () =>
		rep(500, () => `${"…".repeat(4 + Math.floor(rnd() * 5))}${"\r\n".repeat(2 + Math.floor(rnd() * 2))}`);
	cases["ellipsis 4-31 + 1 LF (one break only)"] = () => rep(500, () => `${"…".repeat(4 + Math.floor(rnd() * 28))}\n`);
	cases["middle dots 4-31 + random spaces + LF"] = () =>
		rep(500, () => `${"·".repeat(4 + Math.floor(rnd() * 28))}${" ".repeat(Math.floor(rnd() * 4))}\n`);
	const second = built("third recheck, second round: ", cases);

	rnd = lcg(987654321);
	const s14 = rep(1500, () => pick(["//\n", "// \n", "//\n\n"]));
	const s15 = rep(300, (i) => `${"…".repeat(4 + (i % 12))}${"\r\n".repeat(2 + (i % 6))}`);
	const s16 = rep(1500, () => pick(["//\n", "// \n", "//\n\n"]));
	const sessions = [
		["session 14: 1,500 random '//' blank comment lines", s14],
		["session 15: ellipsis runs between blank CRLF lines", s15],
		["session 16: '//' lines, the second draw", s16],
	] as const;
	return [...first, ...second, ...sessions].map(([name, text]) => ({ name, text: () => text }));
}

/** Punctuation and symbols for drawn markers: ASCII punctuation and common non-ASCII ones. */
const MARK_CHARS = [...PUNCT, ..."—–…·•─│═█░▪→←✓✔✗✘★●○■□▶»«§¶†°±×"];
/** Short text after a marker, of punctuation and symbols. */
const TAILS = [".", "-", "*", "~", "..", "--", "|", ">", "#", "//", "—", "…", "·", ":", "=", "+"];
const EOL_NAMES: Array<[string, string]> = [
	["\n", "LF"],
	["\r\n", "CRLF"],
];

/**
 * Markers in more places, LF and CRLF, each about `size` characters:
 * - after text on the same line (a counter, a timestamp, a word, code), after a space or a tab, then 1 to 3 or 1 to
 *   8 breaks;
 * - markers of 1 to 8 characters made of the markers above with or without spaces between (`// //`, `#--`), or drawn
 *   from punctuation and symbols, one per text or a new one each line, between random blank lines;
 * - a marker with short punctuation or symbol text after it (`// *`, `# --`, `> |`), with or without a space;
 * - markers and closing brackets each followed by a break and 0 to 40 spaces, tabs or both of indentation, so that
 *   the next one is indented.
 */
export function markerPlaceCases(size = 4_000): SweepCase[] {
	const cases: SweepCase[] = [];
	const fill = (seed: number, line: (r: () => number, i: number) => string) => () => {
		const r = rng(seed);
		let s = "";
		for (let i = 0; s.length < size; i++) s += line(r, i);
		return s;
	};
	const pickOf = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
	const breaks = (r: () => number, eol: string, most: number) => eol.repeat(1 + Math.floor(r() * most));
	const heads: Record<string, (r: () => number, i: number) => string> = {
		counter: (_r, i) => `${i}`,
		timestamp: (_r, i) =>
			`2026-11-15T10:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
		word: (r) => pickOf(r, ["ok", "done", "value", "end", "x", "TODO"]),
		code: (r) => pickOf(r, ["x = 1;", "return a", "f(x)", "}", "i++;", "let y = [];"]),
	};
	const composed = (r: () => number, length: number) => {
		let m = "";
		while (m.length < length) m += `${m && r() < 0.5 ? " " : ""}${pickOf(r, MARKERS).trim()}`;
		return m.slice(0, length).trimEnd() || "#";
	};
	for (const [eol, eolName] of EOL_NAMES) {
		for (const m of MARKERS)
			for (const [headName, head] of Object.entries(heads))
				for (const [sep, sepName] of [
					[" ", "a space"],
					["\t", "a tab"],
				])
					for (const most of [3, 8])
						cases.push({
							name: `${headName}, ${sepName}, ${JSON.stringify(m.trim())}, 1 to ${most} breaks, ${eolName}`,
							text: fill(
								m.length * 7_919 + headName.length * 131 + most * 31 + sep.length * 3 + eol.length,
								(r, i) => `${head(r, i)}${sep}${m.trim()}${breaks(r, eol, most)}`,
							),
						});
		for (let length = 1; length <= 8; length++)
			for (const kind of ["composed", "drawn", "composed, a new one each line"])
				for (const seed of [1, 2, 3, 4]) {
					const base = length * 1_009 + kind.length * 17 + seed * 104_729 + eol.length;
					const draw = (r: () => number) =>
						kind === "drawn" ? Array.from({ length }, () => pickOf(r, MARK_CHARS)).join("") : composed(r, length);
					const fixed = draw(rng(base + 1));
					const each = kind.endsWith("each line");
					cases.push({
						name: `${kind} markers of ${length}${each ? "" : ` (${JSON.stringify(fixed)})`}, random blank lines, ${eolName}, seed ${seed}`,
						text: fill(base, (r) => `${each ? draw(r) : fixed}${breaks(r, eol, 4)}`),
					});
				}
		for (const m of MARKERS)
			for (const tail of TAILS)
				for (const sep of [" ", ""])
					cases.push({
						name: `${JSON.stringify(m)}, ${sep ? "a space, " : ""}${JSON.stringify(tail)}, random blank lines, ${eolName}`,
						text: fill(
							m.length * 131 + tail.length * 17 + sep.length + eol.length * 7,
							(r) => `${m}${sep}${tail}${breaks(r, eol, 3)}`,
						),
					});
		for (const m of ["});", "})", "]", "],", "}", ")", ");", ";", "-->", "*/", "//", "#", ">", "|"])
			for (const [low, high] of [
				[0, 8],
				[8, 40],
				[0, 40],
			])
				for (const indent of ["spaces", "tabs", "spaces and tabs"])
					for (const extra of [0, 2])
						cases.push({
							name: `${JSON.stringify(m)}, a break${extra ? ", 0 to 2 blank lines" : ""}, ${low} to ${high} ${indent} of indentation, ${eolName}`,
							text: fill(m.length * 977 + low * 31 + high + indent.length * 7 + extra + eol.length * 3, (r) => {
								const n = low + Math.floor(r() * (high - low + 1));
								const ws = Array.from({ length: n }, () =>
									indent === "spaces" ? " " : indent === "tabs" ? "\t" : pickOf(r, [" ", "\t"]),
								).join("");
								return `${m}${breaks(r, eol, extra + 1)}${ws}`;
							}),
						});
	}
	return cases;
}

/**
 * The fourth and fifth rechecks' cases (their measurements, from one generator in their order, then their sessions 17
 * to 21 and 23 to 25), so the texts are the ones they measured. The fifth's cases draw after the fourth's.
 */
function recheckRounds(): { fourth: SweepCase[]; fifth: SweepCase[] } {
	const lcg = (seed: number) => () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	let rnd = lcg(13572468);
	const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
	const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
	const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
	const b64zero = Buffer.alloc(1500).toString("base64");
	const blanks = (eol: string) => eol.repeat(int(1, 3));
	const cases: Record<string, () => string> = {};
	const EOLS: [string, string][] = [
		["\n", "LF"],
		["\r\n", "CRLF"],
	];
	// 0. Round three's cases below 0.55.
	cases["r3: random '//' lines"] = () => rep(1500, () => pick(["//\n", "// \n", "//\n\n"]));
	cases["r3: random '//' lines CRLF"] = () =>
		rep(1500, () => pick(["//\r\n", "// \r\n", "//\r\n\r\n", "//\r\n\r\n\r\n"]));
	cases["r3: ellipsis 4-15 + 2-7 CRLF"] = () =>
		rep(300, (i) => `${"…".repeat(4 + (i % 12))}${"\r\n".repeat(2 + (i % 6))}`);
	cases["r3: ellipsis 4-31 + 2-7 CRLF"] = () => rep(300, () => `${"…".repeat(int(4, 31))}${"\r\n".repeat(int(2, 7))}`);
	cases["r3: em dash 4-31 + 2-7 LF"] = () => rep(300, () => `${"—".repeat(int(4, 31))}${"\n".repeat(int(2, 7))}`);
	// 1. Markers of 4 or more units.
	for (const m of [
		"////",
		"<!--",
		"//--",
		"#---",
		"/***",
		"// //",
		"####!",
		"-->>",
		">>>>",
		"||||",
		"%%%%",
		"/**/",
		"#!#!",
		"::::",
		"🔥🔥",
		"✅✅",
		"⚠️⚠️",
		"👉👉",
	])
		for (const [eol, nm] of EOLS)
			cases[`4+ marker '${m}' lines + blanks ${nm}`] = () =>
				rep(1200, () => pick([`${m}${eol}`, `${m} ${eol}`, `${m}${blanks(eol)}`]));
	// 2. Indented markers.
	for (const ind of [" ", "  ", "\t", "    ", "\t\t", "        "])
		for (const m of ["*", "//", "#", ">", "|", "--", ";;"])
			cases[`indented ${JSON.stringify(ind)} '${m}' lines + blanks`] = () =>
				rep(1200, () => pick([`${ind}${m}\n`, `${ind}${m} \n`, `${ind}${m}\n\n`]));
	cases["JSDoc blocks of blank ' *' lines"] = () => rep(200, () => `/**\n${rep(int(2, 8), () => " *\n")} */\n`);
	cases["JSDoc blank ' *' lines CRLF, deep indentation"] = () =>
		rep(200, () => `\t\t/**\r\n${rep(int(2, 8), () => "\t\t *\r\n")}\t\t */\r\n`);
	// 3. A marker with text after it (short text the tokenizer may merge).
	for (const t of [".", "-", "x", "0", "*", "~", "..", "—", "…"])
		for (const m of ["//", "#", ">"])
			cases[`'${m} ${t}' lines + blanks`] = () =>
				rep(1200, () => pick([`${m} ${t}\n`, `${m} ${t}\n\n`, `${m}${t}\n`]));
	// 4. Markers mid-line.
	for (const m of ["//", "#", ">", "|", "\\"]) {
		cases[`counter + ' ${m}' + blanks`] = () => rep(800, (i) => `${i} ${m}${blanks("\n")}`);
		cases[`'x ${m}' + blanks`] = () => rep(1200, () => `x ${m}${blanks("\n")}`);
		cases[`'${m}' after a tab, + blanks CRLF`] = () => rep(1200, () => `\t${m}${blanks("\r\n")}`);
	}
	// 5. Runs that a break does not follow, or short runs.
	for (const ch of ["…", "—", "─", "═", "·", "•", "━", "█", "░", "."]) {
		cases[`'${ch}' runs 4-31 + space + 'x' + blanks`] = () =>
			rep(300, () => `${ch.repeat(int(4, 31))} x${blanks("\n")}`);
		cases[`'${ch}' runs 1-3 + blanks`] = () => rep(1500, () => `${ch.repeat(int(1, 3))}${blanks("\n")}`);
		cases[`'${ch}' runs 4-31 + ZWSP + blanks`] = () =>
			rep(300, () => `${ch.repeat(int(4, 31))}\u200b${blanks("\n")}`);
		cases[`'${ch}' runs 4-31 + U+2028 x2-6`] = () =>
			rep(300, () => `${ch.repeat(int(4, 31))}${"\u2028".repeat(int(2, 6))}`);
		cases[`'${ch}${ch === "…" ? "—" : "…"}' alternating 4-31 + blanks CRLF`] = () =>
			rep(300, () => `${rep(int(4, 31), (k) => (k % 2 ? (ch === "…" ? "—" : "…") : ch))}${blanks("\r\n")}`);
	}
	cases["'…' runs 4-31 + NBSP + blanks"] = () => rep(300, () => `${"…".repeat(int(4, 31))}\u00a0${blanks("\n")}`);
	cases["'…' runs 4-31 + ' |' + blanks"] = () => rep(300, () => `${"…".repeat(int(4, 31))} |${blanks("\n")}`);
	cases["astral '🔥' runs 4-31 + blanks"] = () => rep(300, () => `${"🔥".repeat(int(4, 31))}${blanks("\n")}`);
	cases["astral '𝟎' runs 4-31 + blanks"] = () => rep(300, () => `${"𝟎".repeat(int(4, 31))}${blanks("\n")}`);
	// 6. Markers with Unicode breaks the arm does not count.
	for (const [b, nm] of [
		["\u2028", "U+2028"],
		["\u2029", "U+2029"],
		["\u0085", "NEL"],
		["\u000b", "VT"],
		["\u000c", "FF"],
	] as [string, string][])
		for (const m of ["//", "#", ">"])
			cases[`'${m}' lines with ${nm}`] = () => rep(1500, () => pick([`${m}${b}`, `${m} ${b}`, `${m}${b}${b}`]));
	// 7. Mixes with the other arms.
	cases["'//' lines + periodic CRLF/tab whitespace"] = () => rep(400, () => `//\r\n${"\r\n\t".repeat(int(1, 6))}`);
	cases["'//' lines + base64 zeros"] = () =>
		rep(60, () => `${b64zero.slice(0, 80)}\n${rep(int(3, 12), () => pick(["//\n", "// \n", "//\n\n"]))}`);
	cases["'#' lines + dot runs"] = () => rep(400, () => `#\n${".".repeat(int(8, 40))}\n${blanks("\n")}`);
	cases["'>' lines + ellipsis runs + CRLF"] = () =>
		rep(400, () => `>\r\n${"…".repeat(int(4, 20))}\r\n${blanks("\r\n")}`);
	cases["counter + '//' + 16-24 LF"] = () => rep(400, (i) => `${i}\n//${"\n".repeat(int(16, 24))}`);
	cases["'//' + newline + deep indentation"] = () => rep(600, () => `//\n${" ".repeat(int(8, 40))}`);
	cases["'#' + newline + deep tab indentation"] = () => rep(600, () => `#\n${"\t".repeat(int(4, 20))}`);
	cases["'```' fences + blanks"] = () => rep(1200, () => pick(["```\n", "```\n\n", "``` \n"]));
	cases["'\"\"\"' and \"'''\" lines + blanks"] = () => rep(1200, () => pick(['"""\n', "'''\n", '"""\n\n']));
	cases["diff of blank lines ('+', '-', ' ')"] = () => rep(1500, () => pick(["+\n", "-\n", " \n", "+\n\n", "-\r\n"]));
	cases["'_' and '__' lines"] = () => rep(1500, () => pick(["_\n", "__\n", "___\n", "_\n\n"]));
	cases["'})' '});' '];' lines"] = () => rep(1500, () => pick(["})\n", "});\n", "];\n", "}\n\n", ")\n"]));
	// 8. Long breaks (not this commit's pieces, but the same per-unit cost).
	for (const k of [64, 100, 200, 500]) {
		cases[`counter + ${k} LF`] = () => rep(Math.ceil(40_000 / k), (i) => `${i}${"\n".repeat(k)}`);
		cases[`counter + ${k / 2} CRLF`] = () => rep(Math.ceil(40_000 / k), (i) => `${i}${"\r\n".repeat(k / 2)}`);
		cases[`'//' + ${k} LF`] = () => rep(Math.ceil(40_000 / k), () => `//${"\n".repeat(k)}`);
	}
	const roundFour = Object.keys(cases).length;
	// 9. Round five: longer markers and more words, deeper indentation, mixes.
	const PUN = ["/", "*", "-", "=", "#", "<", ">", "!", ";", ")", "}", "]", "|", "~", "+", ":", "…", "—", "→", "•"];
	const word = (n: number) => rep(n, () => pick(PUN));
	for (const n of [8, 9, 10, 12, 16, 24])
		for (const [eol, nm] of EOLS)
			cases[`mixed markers of ${n} + blanks ${nm}`] = () =>
				rep(Math.ceil(5000 / (n + 2)), () => `${word(n)}${blanks(eol)}`);
	for (const w of [3, 4, 5, 6, 8]) {
		cases[`${w} words of 1-3 + blanks`] = () =>
			rep(600, () => `${rep(w, (k) => `${k ? " " : ""}${word(int(1, 3))}`)}${blanks("\n")}`);
		cases[`'//' x${w} words + blanks`] = () => rep(600, () => `${Array(w).fill("//").join(" ")}${blanks("\n")}`);
		cases[`counter + ${w} words of '//' + blanks`] = () =>
			rep(500, (i) => `${i} ${Array(w).fill("//").join(" ")}${blanks("\n")}`);
	}
	for (const inner of ["a", "0", "x", "é", "_", "ß", "٣"]) {
		cases[`marker with '${inner}' inside + blanks`] = () => rep(1000, () => `/${inner}/${blanks("\n")}`);
		cases[`counter + ' -${inner}->' + blanks`] = () => rep(800, (i) => `${i} -${inner}->${blanks("\n")}`);
	}
	for (const gap of ["  ", "\t\t", " \t", "   "]) {
		cases[`'//${JSON.stringify(gap)}//' + blanks`] = () => rep(1000, () => `//${gap}//${blanks("\n")}`);
		cases[`counter + ${JSON.stringify(gap)} + '//' + blanks`] = () => rep(800, (i) => `${i}${gap}//${blanks("\n")}`);
		cases[`counter + ${JSON.stringify(gap)} + '-->' + blanks`] = () =>
			rep(800, (i) => `${i}${gap}-->${blanks("\n")}`);
	}
	for (const sep of ["\u00a0", "\u3000", "\u2009", "\u200b", "\u000b"]) {
		cases[`counter + ${JSON.stringify(sep)} + '//' + blanks`] = () => rep(800, (i) => `${i}${sep}//${blanks("\n")}`);
		cases[`'//' + ${JSON.stringify(sep)} + '//' + blanks`] = () => rep(1000, () => `//${sep}//${blanks("\n")}`);
	}
	for (const ws of [" ", "  ", "\t", "\u00a0", "\u2028", " \u2028"]) {
		cases[`'//' before ${JSON.stringify(ws)} without a break, then text`] = () => rep(800, (i) => `//${ws}x${i}\n`);
		cases[`'});' before ${JSON.stringify(ws)} lines`] = () => rep(1200, () => `});${ws}${blanks("\n")}`);
	}
	for (const [lo, hi] of [
		[40, 60],
		[60, 100],
		[100, 200],
		[200, 400],
	] as [number, number][])
		for (const m of ["});", "}", "-->", "//", "*/", "]"]) {
			cases[`'${m}' + LF + ${lo}-${hi} spaces`] = () =>
				rep(Math.ceil(20_000 / hi), () => `${m}\n${" ".repeat(int(lo, hi))}`);
			cases[`'${m}' + LF + ${lo}-${hi} spaces + word`] = () =>
				rep(Math.ceil(20_000 / hi), (i) => `${m}\n${" ".repeat(int(lo, hi))}w${i % 9}`);
			cases[`'${m}' + LF + ${lo / 4}-${hi / 4} tabs`] = () =>
				rep(Math.ceil(20_000 / hi), () => `${m}\n${"\t".repeat(int(lo / 4, hi / 4))}`);
		}
	for (const m of ["-->", "});"])
		cases[`r4 probe: '${m}' + LF + 8-40 spaces`] = () => rep(600, () => `${m}\n${" ".repeat(int(8, 40))}`);
	for (const k of [16, 40, 100]) {
		cases[`'});' + ${k} blank lines with indentation`] = () =>
			rep(Math.ceil(20_000 / k), () => `});${rep(k / 4, () => `\n${" ".repeat(int(0, 8))}`)}`);
		cases[`counter + ' //' + ${k} LF`] = () => rep(Math.ceil(20_000 / k), (i) => `${i} //${"\n".repeat(k)}`);
	}
	cases["'// //' lines + base64 zeros"] = () =>
		rep(60, () => `${b64zero.slice(0, 80)}\n${rep(int(3, 12), () => pick(["// //\n", "// // \n", "// //\n\n"]))}`);
	cases["markers + periodic whitespace"] = () => rep(400, () => `}); //${"\r\n\t".repeat(int(1, 6))}`);
	cases["markers + dot runs"] = () => rep(400, () => `// ${".".repeat(int(8, 40))}\n${blanks("\n")}`);
	cases["markers + box runs + markers"] = () => rep(400, () => `// ${"─".repeat(int(4, 30))} //${blanks("\n")}`);
	cases["emoji markers of 1-3 words"] = () =>
		rep(
			800,
			() =>
				`${rep(int(1, 3), (k) => `${k ? " " : ""}${pick(["🔥", "✅", "⚠️", "👉", "❌"]).repeat(int(1, 4))}`)}${blanks("\n")}`,
		);
	cases["combining marks as markers"] = () => rep(1000, () => `${"\u0301".repeat(int(1, 8))}${blanks("\n")}`);
	cases["CJK punctuation markers"] = () =>
		rep(1000, () => `${pick(["。", "、", "「」", "【】", "・・", "〜"])}${blanks("\n")}`);
	cases["markdown list of only '- [ ]'"] = () => rep(1000, () => `- [ ]${blanks("\n")}`);
	cases["'| --- |' table rows"] = () => rep(800, () => `| --- | --- | --- |${blanks("\n")}`);
	cases["'* * *' and '- - -' rules"] = () => rep(1000, () => `${pick(["* * *", "- - -", "_ _ _"])}${blanks("\n")}`);
	cases["counter + ' => {' before indentation"] = () => rep(600, (i) => `x${i} => {\n${" ".repeat(int(8, 40))}`);
	cases["prompt '$ ' lines"] = () => rep(1500, () => pick(["$\n", "$ \n", "> $ \n", "$\n\n"]));
	cases["ruby/elixir 'end' style 'do |x|'"] = () => rep(800, (i) => `do |x${i}|\n${" ".repeat(int(2, 12))}`);

	// Built in insertion order: the random draws run through one generator.
	const measured = Object.entries(cases).map(
		([name, f], i) => [`${i < roundFour ? "fourth" : "fifth"} recheck: ${name}`, f()] as const,
	);

	rnd = lcg(987654321);
	const mid = rep(800, (i) => `${i} //${"\n".repeat(int(1, 3))}`);
	const five = rep(1200, () => pick(["// //\n", "// // \n", `// //${"\n".repeat(int(1, 3))}`]));
	const star = rep(1200, () => pick(["// *\n", "// *\n\n", "//*\n"]));
	const arrow = rep(600, () => `-->\n${" ".repeat(int(8, 40))}`);
	const close = rep(600, () => `});\n${" ".repeat(int(8, 40))}`);
	const sessions = [
		["session 17: a counter, then ' //' mid-line, then 1 to 3 breaks", mid],
		["session 18: '// //' lines between blank lines", five],
		["session 19: '// *' lines between blank lines", star],
		["session 20: '-->' lines with 8 to 40 spaces of indentation", arrow],
		["session 21: '});' lines with 8 to 40 spaces of indentation", close],
	] as const;
	rnd = lcg(987654321);
	const deepClose = rep(600, () => `});\n${" ".repeat(int(40, 60))}`);
	const deepArrow = rep(600, () => `-->\n${" ".repeat(int(40, 60))}`);
	const four = rep(600, () => `// // // //${blanks("\n")}`);
	const fifthSessions = [
		["session 23: '});' lines with 40 to 60 spaces of indentation", deepClose],
		["session 24: '-->' lines with 40 to 60 spaces of indentation", deepArrow],
		["session 25: '// // // //' lines between blank lines", four],
	] as const;
	const toCases = (xs: ReadonlyArray<readonly [string, string]>) =>
		xs.map(([name, text]) => ({ name, text: () => text }));
	return {
		fourth: toCases([...measured.slice(0, roundFour), ...sessions]),
		fifth: toCases([...measured.slice(roundFour), ...fifthSessions]),
	};
}

let rounds: ReturnType<typeof recheckRounds> | undefined;
/** The fourth recheck's cases and its sessions 17 to 21. */
export function fourthRecheckCases(): SweepCase[] {
	rounds ??= recheckRounds();
	return rounds.fourth;
}
/** The fifth recheck's cases and its sessions 23 to 25. */
export function fifthRecheckCases(): SweepCase[] {
	rounds ??= recheckRounds();
	return rounds.fifth;
}
