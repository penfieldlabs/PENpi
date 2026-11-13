/**
 * The floor sweep's texts (floor-sweep.test.ts): honest tool output that the engine's estimate can overcount, built
 * from a seeded generator so every run builds the same texts.
 * - Generated: periods of 1 to 8 characters drawn from every ASCII character (control characters, whitespace,
 *   punctuation, letters and digits) and common non-ASCII ones (box drawing, block elements, symbols, emoji, CJK,
 *   Hangul, accented and combining marks, invisible spaces), each repeated to 1,000, 10,000 and 100,000 characters
 *   in five layouts: alone, one per line with LF, one per line with CRLF, numbered lines, and timestamped CRLF lines.
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
