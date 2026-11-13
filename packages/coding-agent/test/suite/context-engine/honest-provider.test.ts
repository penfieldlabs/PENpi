/**
 * E3.5: an honest provider is never reported as truncating, with ordinary tool output that the engine's estimate
 * overcounts many times: runs of one character (test dot reporters, rules, stat bars) and other repetition (base64 of
 * a zero-filled file, `-=-=` rules, blank CRLF lines).
 *
 * The provider here counts every request with the real o200k tokenizer (E2's simulator), accepts everything up to
 * the declared window and never truncates. The session is ordinary coding work: source files, `git diff --stat`,
 * a test run that prints one dot per test. Every test expects no detection. Tests 1 and 2 detected in 0.7.0 too;
 * tests 3 and 4 came with ADR 0033 (the marginal pair) before its size guard. Tests 5 and 6 detected in 0.7.0 and
 * with the floor for runs of one character alone. Test 7 detected with the floor before its arm for short periods,
 * test 9 before its arm for whitespace that holds a line break; tests 10 to 13 are whitespace of that kind too.
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { installProviderSim } from "../context-engine-e2/provider-sim.ts";
import { CountingTokenizer, loadTokenizer } from "../context-engine-e2/tokenizers.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { blobExtension, finalTurn, scriptedModel } from "./helpers.ts";

const harnesses: Harness[] = [];

// Honest, ordinary content: this repository's own source.
const source = [
	"agent-session.ts",
	"session-manager.ts",
	"settings-manager.ts",
	"package-manager.ts",
	"model-runtime.ts",
	"sdk.ts",
]
	.map((f) => readFileSync(new URL(`../../../src/core/${f}`, import.meta.url), "utf8"))
	.join("\n");
// The blobs below take the first 420,000 characters.
if (source.length < 420_000) throw new Error(`honest-provider: ${source.length} characters of source, 420,000 needed`);

/** `python -m unittest` at default verbosity: one "." per test on one line, a 70-dash rule, the summary. */
const unittest = (tests: number) => `${".".repeat(tests)}\n${"-".repeat(70)}\nRan ${tests} tests in 41.512s\n\nOK\n`;
/** `git diff --stat` over `files` files. */
const diffStat = (files: number) =>
	`${Array.from(
		{ length: files },
		(_, i) =>
			` src/module_${i}/handler_${i}.ts | ${String(10 + ((i * 7) % 90)).padStart(3)} ${"+".repeat(10 + ((i * 7) % 40))}${"-".repeat((i * 3) % 20)}`,
	).join("\n")}\n ${files} files changed, 2140 insertions(+), 612 deletions(-)\n`;

interface Step {
	blob: string;
	say?: string;
}

async function session(window: number, steps: Step[], blobs: Record<string, string>, options = {}) {
	const stats = newStats();
	const lines: string[] = [];
	const notices: string[] = [];
	const harness = await createHarness({
		models: [{ id: "honest", contextWindow: window, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			blobExtension(Object.fromEntries(Object.entries(blobs).map(([k, text]) => [k, { text }]))),
			createContextEngine({ stats, ...options, log: (l: string) => lines.push(l) }),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
	// Honest: rejects only above the declared window, never truncates, reports exactly what it counted.
	const sim = installProviderSim(harness, {
		tokenizer: "o200k",
		counter: new CountingTokenizer(await loadTokenizer("o200k")),
		limit: window,
		mode: "reject",
		errorStyle: "anthropic",
	});
	const model = scriptedModel(harness);
	steps.forEach((step, n) => {
		model.push(() =>
			fauxAssistantMessage(
				[
					fauxText(step.say ?? `Step ${n}: reading the next part.`),
					fauxToolCall("blob", { name: step.blob }, { id: `call-${n}` }),
				],
				{ stopReason: "toolUse" },
			),
		);
	});
	model.push(finalTurn("All done."));
	await harness.session.prompt("Work through the task: read the code, check the diff, run the tests, report.");
	return { stats, lines, notices, sim };
}

/** The provider truncated and rejected nothing, and the engine reported no truncation and learned no window. */
function expectHonest(r: Awaited<ReturnType<typeof session>>, window: number) {
	expect(r.sim.calls.filter((c) => c.truncated || c.rejected)).toHaveLength(0);
	expect(r.stats.plateaus, r.lines.filter((l) => l.includes("silent truncation")).join("\n")).toHaveLength(0);
	expect(r.notices.filter((n) => n.includes("silently truncated"))).toHaveLength(0);
	expect(r.stats.lastLimits?.window).toBe(window);
}

describe("E3.5: an honest provider and ordinary tool output", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// A long session: about 96,000 tokens in context, then steps of about 1% of the context each.
	const big = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => [`big${i}`, source.slice(i * 32_000, (i + 1) * 32_000)]),
	);
	const small = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => [`small${i}`, source.slice(384_000 + i * 3_000, 384_000 + (i + 1) * 3_000)]),
	);
	const code = Object.fromEntries(
		Array.from({ length: 20 }, (_, i) => [`code${i}`, source.slice(i * 8_000, (i + 1) * 8_000)]),
	);
	const preload: Step[] = Array.from({ length: 12 }, (_, i) => ({ blob: `big${i}` }));
	const smalls = (from: number, n: number): Step[] =>
		Array.from({ length: n }, (_, i) => ({ blob: `small${from + i}` }));
	const codes = (from: number, n: number): Step[] =>
		Array.from({ length: n }, (_, i) => ({ blob: `code${from + i}` }));
	const TESTS = "Running the test suite.";

	it("control: source code only, no detection", async () => {
		const r = await session(200_000, [...preload, ...smalls(0, 12)], { ...big, ...small });
		expectHonest(r, 200_000);
	});

	it("1: one unittest run with 2,000 passing tests, no detection (0.7.0 read it as strong evidence)", async () => {
		const r = await session(200_000, [...preload, ...smalls(0, 3), { blob: "tests", say: TESTS }, ...smalls(3, 8)], {
			...big,
			...small,
			tests: unittest(2_000),
		});
		expectHonest(r, 200_000);
	});

	it("2: a unittest run with 600 tests, twice within the span, no detection (0.7.0 read two evidence samples)", async () => {
		const r = await session(
			200_000,
			[
				...preload,
				...smalls(0, 3),
				{ blob: "tests", say: TESTS },
				...smalls(3, 3),
				{ blob: "tests", say: TESTS },
				...smalls(6, 6),
			],
			{ ...big, ...small, tests: unittest(600) },
		);
		expectHonest(r, 200_000);
	});

	it("3: `git diff --stat`, then one unittest run with 600 tests, no detection (a marginal pair before the floor)", async () => {
		const steps: Step[] = [
			...preload,
			...smalls(0, 3),
			{ blob: "stat", say: "Checking the diff." },
			...smalls(3, 2),
			{ blob: "tests", say: TESTS },
			...smalls(5, 6),
		];
		const blobs = { ...big, ...small, stat: diffStat(80), tests: unittest(600) };
		// 0.7.0's rule (the pair off) does not detect: the lone evidence sample waits for a second.
		expectHonest(await session(200_000, steps, blobs, { silentMarginalPair: false }), 200_000);
		expectHonest(await session(200_000, steps, blobs), 200_000);
	});

	it("4: a 600-test run before a cut and again after it, far below the largest usage, no detection (the size guard)", async () => {
		// 32k model. A 600-test run right before a cut is one evidence sample. The same run right after the cut is at
		// about 60% of the largest usage reported, so it cannot be evidence (the 0.8 size guard); it is "marginal".
		const steps: Step[] = [
			...codes(0, 9),
			{ blob: "tests", say: TESTS },
			...codes(9, 2),
			{ blob: "tests", say: TESTS },
			...codes(11, 2),
		];
		const blobs = { ...code, tests: unittest(600) };
		expectHonest(await session(32_000, steps, blobs, { silentMarginalPair: false }), 32_000);
		expectHonest(await session(32_000, steps, blobs), 32_000);
	});

	// Repetition that is not a run of one character: the floor's bound on repeated segments (textTokensFloor).
	it("5: `base64` of a zero-filled 3,000-byte file, read twice, no detection", async () => {
		const blob = `${Buffer.alloc(3_000).toString("base64")}\n`;
		const r = await session(
			200_000,
			[...preload, ...smalls(0, 3), { blob: "b64" }, ...smalls(3, 3), { blob: "b64" }, ...smalls(6, 6)],
			{ ...big, ...small, b64: blob },
		);
		expectHonest(r, 200_000);
	});

	it("6: a report ruled with `-=-=` lines, twice, no detection", async () => {
		const report = Array.from({ length: 30 }, (_, i) => `section ${i}\n${"-=".repeat(35)}`).join("\n");
		const r = await session(
			200_000,
			[...preload, ...smalls(0, 3), { blob: "rules" }, ...smalls(3, 3), { blob: "rules" }, ...smalls(6, 6)],
			{ ...big, ...small, rules: report },
		);
		expectHonest(r, 200_000);
	});

	// Whitespace that repeats with a period of two or more: the floor's arm for short periods (textTokensFloor).
	it("7: a program that prints 1,500 blank CRLF lines, read twice, no detection", async () => {
		const blob = `Output:\r\n${"\r\n".repeat(1_500)}Done.\r\n`;
		const r = await session(
			200_000,
			[...preload, ...smalls(0, 3), { blob: "crlf" }, ...smalls(3, 3), { blob: "crlf" }, ...smalls(6, 6)],
			{ ...big, ...small, crlf: blob },
		);
		expectHonest(r, 200_000);
	});

	it("8: a CRLF log with three blank lines after each entry, read twice, no detection", async () => {
		const blob = Array.from({ length: 300 }, (_, i) => `entry ${i} ok\r\n\r\n\r\n\r\n`).join("");
		const r = await session(
			200_000,
			[...preload, ...smalls(0, 3), { blob: "log" }, ...smalls(3, 3), { blob: "log" }, ...smalls(6, 6)],
			{ ...big, ...small, log: blob },
		);
		expectHonest(r, 200_000);
	});

	// Whitespace that holds a line break, of any length and with no period: the floor's arm for it.
	let seed = 987654321;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const twice = async (name: string, text: string) => {
		const r = await session(
			200_000,
			[...preload, ...smalls(0, 3), { blob: name }, ...smalls(3, 3), { blob: name }, ...smalls(6, 6)],
			{ ...big, ...small, [name]: text },
		);
		expectHonest(r, 200_000);
	};

	it("9: a counter line, then 7 blank CRLF lines, 400 times, read twice, no detection", async () => {
		await twice("counter", Array.from({ length: 400 }, (_, i) => `${i}${"\r\n".repeat(8)}`).join(""));
	});

	it("10: CRLF x5 and a tab, 400 times (period 11), read twice, no detection", async () => {
		await twice("p11", "\r\n\r\n\r\n\r\n\r\n\t".repeat(400));
	});

	it("11: CRLF lines with blank stretches of 1 to 15 lines, read twice, no detection", async () => {
		await twice(
			"gaps",
			Array.from({ length: 300 }, (_, i) => `l${i}\r\n${"\r\n".repeat(1 + Math.floor(rnd() * 15))}`).join(""),
		);
	});

	it("12: 1,500 blank lines with 0 to 6 trailing spaces, read twice, no detection", async () => {
		await twice("trail", Array.from({ length: 1500 }, () => `${" ".repeat(Math.floor(rnd() * 7))}\n`).join(""));
	});

	it("13: 14 blank CRLF lines after each of 150 entries, read twice, no detection", async () => {
		await twice("blank14", Array.from({ length: 150 }, (_, i) => `ok ${i}\r\n${"\r\n".repeat(14)}`).join(""));
	});
});
