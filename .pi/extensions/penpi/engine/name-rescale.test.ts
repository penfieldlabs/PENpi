/**
 * 0.8.0, ADR 0034: at a detection, D14 also judges the samples of an append chain from its first doubtful sample on at
 * the ratio from before that sample, raising only. The fixtures are E2's data.o200k.1m.silent-messages, read from its
 * run JSON and engine log, on the v1.5.1 corpus (call 31 truncated and unnamed before this) and the v1.5.0 corpus
 * (an honest fall of the ratio after a cut, which must name nothing new).
 */

import { describe, expect, it } from "vitest";
import { namedSamples } from "./detector.ts";
import { DEFAULTS } from "./options.ts";

type Sample = Parameters<typeof namedSamples>[0][number];
const clamp = (r: number) => Math.min(6, Math.max(0.8, r));
const FLAT = 0.02;
/** One sample: its call, the engine's estimate and the ratio it was judged at (expected = estimate x ratio). */
const at = (
	call: number,
	estimate: number,
	ratio: number,
	reported: number,
	chain: number,
	extra: Partial<Sample> = {},
) => ({ at: call, expected: estimate * ratio, reported, ratio, chain, provider: undefined, ...extra }) as Sample;
const calls = (s: Sample[]) => s.map((x) => x.at);

// The chain numbers stand for the runs' append chains: calls 29 to 31 share one, and the cut at 32 starts the one that
// holds 33 to 48.
// v1.5.1 corpus. Chain 3 holds calls 29 to 31 (the cut at 32 starts chain 4); call 30 is marginal (+5,910 for
// 12,639 appended) and moved the ratio from 0.99264 to 0.98108; call 31 grew by exactly its append. Call 48 is the
// strong sample; the learned window is call 47's report, 99,718, so D14's line is 101,712.
const v151 = [
	at(29, 89_952, 0.99, 90_083, 3),
	at(30, 102_685, 0.99264, 95_993, 3, { marginal: true }),
	at(31, 103_603, 0.98108, 96_940, 3),
	at(45, 96_795, 1.008, 97_796, 4),
	at(46, 97_980, 1.008, 99_069, 4),
	at(47, 99_022, 1.009, 99_718, 4),
	at(48, 101_954, 1.009, 98_396, 4, { suspect: "2958 tokens appended, reported usage -1322" }),
];
const v151Window = 99_718;
// D14 as before names call 30 (expected 101,929, above the line) and the quarantined call 48.
const v151Affected = [v151[1], v151[6]];

// v1.5.0 corpus. Calls 30 and 31 marginal in chain 3 (ratio 1.011 before 30); after the cut the content changes and
// the ratio falls for real, to 0.969, where requests 45 to 47 near the window are honest (true tokens / estimate about
// 0.968). Call 48 is evidence and joins the two marginal samples; the window is 99,723.
const v150 = [
	at(29, 94_345, 1.013, 94_436, 3),
	at(30, 107_569, 1.011, 99_129, 3, {
		marginal: true,
		suspect: "13367 tokens appended, reported usage +4693 (marginal)",
	}),
	at(31, 108_489, 0.993, 99_572, 3, {
		marginal: true,
		suspect: "914 tokens appended, reported usage +443 (marginal)",
	}),
	at(45, 100_106, 0.971, 96_716, 4),
	at(46, 101_325, 0.97, 98_026, 4),
	at(47, 102_367, 0.969, 99_073, 4),
	at(48, 105_449, 0.969, 99_723, 4, { suspect: "2986 tokens appended, reported usage +650" }),
];
const v150Window = 99_723;
const v150Affected = [v150[1], v150[2], v150[6]];

describe("ADR 0034: D14 names from the ratio before the chain's first doubtful sample", () => {
	it("data.o200k.1m.silent-messages on the v1.5.1 corpus: the strong detection after a marginal sample names call 31 too", () => {
		// The shipped default: with the rule off this fails, and call 31 is unnamed as before.
		expect(calls(namedSamples(v151, v151Affected, v151Window, FLAT, clamp, DEFAULTS.silentNameRescale))).toEqual([
			30, 31, 48,
		]);
		// Call 31 at its own ratio is about 70 tokens under the line, and above it at call 30's ratio.
		expect(v151[2].expected).toBeLessThan(v151Window * (1 + FLAT));
		expect((v151[2].expected / 0.98108) * 0.99264).toBeGreaterThan(v151Window * (1 + FLAT));
	});

	it("control: with the rule off (the internal option), the names are today's, and call 31 is not among them", () => {
		const off = namedSamples(v151, v151Affected, v151Window, FLAT, clamp, false);
		expect(off).toBe(v151Affected);
		expect(calls(off)).not.toContain(31);
	});

	it("an honest fall of the ratio after a cut names nothing new (data.o200k.1m.silent-messages on the v1.5.0 corpus)", () => {
		expect(calls(namedSamples(v150, v150Affected, v150Window, FLAT, clamp, true))).toEqual([30, 31, 48]);
		// Across the whole span instead of per chain, the ratio from before call 30 would name the honest 46 and 47.
		const spanWide = v150.filter((s) => (s.expected / s.ratio) * 1.011 > v150Window * (1 + FLAT)).map((s) => s.at);
		expect(spanWide).toEqual(expect.arrayContaining([46, 47]));
	});

	it("raises only: a sample judged at a ratio above the chain's first doubtful one keeps its own expected size", () => {
		// Ratio 1.05 after a doubtful sample at 0.99: rescaled down it would fall under the line, at its own it is above.
		const s = [
			at(10, 50_000, 0.99, 48_000, 1, { marginal: true }),
			at(11, 50_500, 1.05, 50_400, 1),
			at(12, 51_000, 0.99, 49_500, 1, { suspect: "strong" }),
		];
		const window = 51_000;
		const affected = [s[1], s[2]];
		expect(calls(namedSamples(s, affected, window, FLAT, clamp, true))).toEqual([11, 12]);
		// Not affected, same numbers: still named at its own expected size (53,025 above 52,020), never dropped.
		expect(calls(namedSamples(s, [s[2]], window, FLAT, clamp, true))).toEqual([11, 12]);
	});

	it("no doubtful sample in a chain: that chain's names are today's", () => {
		const s = [
			at(20, 60_000, 0.95, 57_000, 2),
			at(21, 61_000, 0.95, 57_500, 2),
			at(30, 62_000, 0.95, 58_000, 3, { suspect: "strong" }),
		];
		// Call 21 would cross the line at a ratio of 1.0, but its chain has no doubtful sample.
		expect(calls(namedSamples(s, [s[2]], 58_000, FLAT, clamp, true))).toEqual([30]);
	});

	it("samples before the chain's first doubtful sample keep their own ratio", () => {
		const s = [
			at(5, 60_000, 0.95, 57_000, 1),
			at(6, 58_000, 1.0, 57_500, 1, { marginal: true }),
			at(7, 62_000, 0.99, 58_500, 1, { suspect: "strong" }),
		];
		// Call 5 at call 6's ratio would be 60,000 > 59,670, but it came first.
		expect(calls(namedSamples(s, [s[2]], 58_500, FLAT, clamp, true))).toEqual([7]);
	});
});
