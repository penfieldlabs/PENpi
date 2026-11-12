import { describe, expect, it } from "vitest";
import {
	answersProduced,
	clearsMarginals,
	completesMarginalPair,
	replayRecommendation,
	replayVerdict,
} from "./detector.ts";

describe("silent-truncation warning wording", () => {
	it("counts one answer in the singular and any other number in the plural", () => {
		expect(answersProduced(1)).toBe("1 answer was produced");
		expect(answersProduced(2)).toBe("2 answers were produced");
		expect(answersProduced(12)).toBe("12 answers were produced");
	});
});

describe("replay check verdict (review round 2, Later 1 and 2)", () => {
	const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

	it("counted from a median of 0.5; ignored only below 0.3; nothing in between", () => {
		expect(replayVerdict(repeat(0.98, 20))).toBe("counted");
		expect(replayVerdict(repeat(0.55, 20))).toBe("counted");
		expect(replayVerdict(repeat(0.05, 20))).toBe("ignored");
		// An estimator that over-counts makes a counting provider look like about 0.4: no recommendation.
		expect(replayVerdict(repeat(0.4, 20))).toBeUndefined();
		expect(replayVerdict(repeat(0.29, 20))).toBe("ignored");
	});

	it("no verdict when the shares split into two clusters (a provider that counts in tool loops only)", () => {
		expect(replayVerdict([...repeat(0.02, 12), ...repeat(0.97, 8)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.97, 12), ...repeat(0.02, 8)])).toBeUndefined();
		// A few strays do not make two clusters.
		expect(replayVerdict([...repeat(0.97, 17), ...repeat(0.02, 3)])).toBe("counted");
	});

	it("N1: no ignored while a tenth of the pairs, or 3, count the replay (an over-counted 0.6 included)", () => {
		// The review's two inputs.
		expect(replayVerdict([...repeat(0.02, 12), ...repeat(0.6, 8)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 16), ...repeat(0.97, 4)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 18), ...repeat(0.97, 2)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 37), ...repeat(0.97, 3)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 19), ...repeat(0.97, 1)])).toBe("ignored");
		expect(replayVerdict([...repeat(0.02, 38), ...repeat(0.97, 2)])).toBe("ignored");
		// The safe direction keeps its 25% rule.
		expect(replayVerdict([...repeat(0.97, 16), ...repeat(0.02, 4)])).toBe("counted");
		expect(replayVerdict([...repeat(0.97, 15), ...repeat(0.02, 5)])).toBeUndefined();
	});

	it("D22: no ignored while a tenth of the pairs, or 3, are at 0.3 or more (a 0/0.4 split)", () => {
		expect(replayVerdict([...repeat(0.02, 12), ...repeat(0.4, 8)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 18), ...repeat(0.4, 2)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 37), ...repeat(0.3, 3)])).toBeUndefined();
		expect(replayVerdict([...repeat(0.02, 19), ...repeat(0.4, 1)])).toBe("ignored");
		expect(replayVerdict([...repeat(0.02, 38), ...repeat(0.4, 2)])).toBe("ignored");
		expect(replayVerdict([...repeat(0.02, 17), ...repeat(0.29, 3)])).toBe("ignored");
		// Without a verdict, the split recommends nothing either way: only pairs at 0.5 or more recommend counted.
		expect(replayRecommendation([...repeat(0.02, 12), ...repeat(0.4, 8)], "counted")).toBeUndefined();
		expect(replayRecommendation([...repeat(0.02, 12), ...repeat(0.4, 8)], "ignored")).toBeUndefined();
	});

	it("N1 (round 4): with ignored set, enough pairs that count the replay recommend counted, without a verdict", () => {
		const mixed = [...repeat(0.02, 12), ...repeat(0.97, 8)];
		expect(replayRecommendation(mixed, "ignored")).toBe("counted");
		// The setting that already counts gets nothing without a verdict.
		expect(replayRecommendation(mixed, "counted")).toBeUndefined();
		// 2 of 20 at 0.97 withhold "ignored" too (a tenth): with ignored set, they still recommend counted.
		expect(replayRecommendation([...repeat(0.02, 18), ...repeat(0.97, 2)], "ignored")).toBe("counted");
		// A verdict decides as before.
		expect(replayRecommendation(repeat(0.05, 20), "ignored")).toBeUndefined();
		expect(replayRecommendation(repeat(0.05, 20), "counted")).toBe("ignored");
		expect(replayRecommendation(repeat(0.98, 20), "ignored")).toBe("counted");
		expect(replayRecommendation(repeat(0.4, 20), "ignored")).toBeUndefined();
	});
});

describe("ADR 0033: a marginal sample and an evidence sample within the span", () => {
	it("an evidence sample completes the pair with a marginal sample in the span, and a marginal one with evidence", () => {
		expect(completesMarginalPair("evidence", 0, 1)).toBe(true);
		expect(completesMarginalPair("evidence", 0, 2)).toBe(true);
		expect(completesMarginalPair("marginal", 1, 0)).toBe(true);
		expect(completesMarginalPair("marginal", 1, 3)).toBe(true);
	});

	it("two marginal samples never complete it, and a lone sample does not either", () => {
		expect(completesMarginalPair("marginal", 0, 1)).toBe(false);
		expect(completesMarginalPair("marginal", 0, 5)).toBe(false);
		expect(completesMarginalPair("evidence", 0, 0)).toBe(false);
		expect(completesMarginalPair("marginal", 0, 0)).toBe(false);
	});

	it("a clean sample clears marginal samples only above everything reported, by more than the flatness", () => {
		const marginals = [{ reported: 15_831 }];
		// E2's research.glm.32k.silent-messages: calls 13 to 17 report below 15,831 and keep it.
		expect(clearsMarginals(15_105, 15_831, marginals, 0.02)).toBe(false);
		expect(clearsMarginals(16_147, 15_831, marginals, 0.02)).toBe(false);
		expect(clearsMarginals(16_148, 15_831, marginals, 0.02)).toBe(true);
		// The larger of the running maximum and the marginal samples' reports.
		expect(clearsMarginals(16_149, 16_000, marginals, 0.02)).toBe(false);
		expect(clearsMarginals(20_000, 15_831, [], 0.02)).toBe(false);
	});
});
