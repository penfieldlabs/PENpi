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
