/**
 * E3.5: the growth check's floor (textTokensFloor) against real tokens, over a seeded sweep of honest text
 * (floor-sweep-cases.ts), with o200k and with GLM-5.3-Flash as E2 counts them. Below 0.25 an honest append would
 * read as evidence of truncation: no case may. Between 0.25 and 0.5 it reads marginal, which never detects alone or
 * with another marginal sample (ADR 0033). The honest shapes known to read there (markers after text on the same
 * line, marker lines of two or more words, closing brackets and markers before indentation) are left there, so the
 * floor keeps its strength on ordinary output. The sweep fails if more of them fall below 0.5, or if any falls below
 * the lowest measured; a known shape can still go lower inside the band without failing.
 *
 * The default run takes the periodic cases at 1,000 and 10,000 characters, the whitespace, marker-line and non-ASCII
 * cases at about 4,000, and every named case. FLOOR_SWEEP_FULL=1 adds the periodic cases at 100,000 characters (about 80 minutes).
 * FLOOR_SWEEP_REPORT=<file> writes every ratio there.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { textTokensFloor } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
import { loadTokenizer } from "../context-engine-e2/tokenizers.ts";
import {
	fifthRecheckCases,
	fourthRecheckCases,
	generatedCases,
	markerLineCases,
	markerPlaceCases,
	namedCases,
	nonAsciiRunCases,
	recheckCases,
	SWEEP_SIZES,
	thirdRecheckCases,
	whitespaceCases,
} from "./floor-sweep-cases.ts";
import { fastO200k, reference } from "./o200k-fast.ts";

const full = process.env.FLOOR_SWEEP_FULL === "1";
const sizes = full ? SWEEP_SIZES : SWEEP_SIZES.filter((s) => s <= 10_000);
/**
 * The floor's figures as measured, the same with and without FLOOR_SWEEP_FULL (20,751 and 24,321 cases): 54 cases
 * between 0.25 and 0.5, the lowest 0.343 (a counter, a space and `-->`, then 1 to 3 breaks). There were 73 before CR
 * and the other characters Claude's tokenizers drop cost nothing (FLOOR_FREE): the CRLF forms of 19 of them left the band.
 */
const KNOWN = { marginal: 54, lowest: 0.343 };
const fixed = () => [
	...recheckCases(),
	...thirdRecheckCases(),
	...fourthRecheckCases(),
	...fifthRecheckCases(),
	...namedCases(),
	...whitespaceCases(),
	...markerLineCases(),
	...markerPlaceCases(),
	...nonAsciiRunCases(),
];

describe("E3.5: the floor holds for honest text, over a seeded sweep", () => {
	it("the heap merge counts o200k as js-tiktoken does", () => {
		const texts = [...fixed(), ...generatedCases([1_000])]
			.filter((_, i) => i % 53 === 0)
			.map((c) => c.text().slice(0, 1_000));
		expect(texts.length).toBeGreaterThan(40);
		for (const t of texts)
			expect(fastO200k(t), JSON.stringify(t.slice(0, 40))).toBe(reference.encode(t, "all").length);
	});

	it(
		"no case is below 0.25 of the floor, and the marginal cases are no more and no lower than known",
		async () => {
			const glm = await loadTokenizer("glm");
			const rows = [...fixed(), ...generatedCases(sizes)].map((c) => {
				const text = c.text();
				const floor = textTokensFloor(text);
				const o200k = fastO200k(text);
				const g = glm.count(text);
				return { name: c.name, chars: text.length, floor, o200k, glm: g, ratio: Math.min(o200k, g) / floor };
			});
			rows.sort((a, b) => a.ratio - b.ratio);
			if (process.env.FLOOR_SWEEP_REPORT) writeFileSync(process.env.FLOOR_SWEEP_REPORT, JSON.stringify(rows));
			const lowest = `lowest: ${rows
				.slice(0, 5)
				.map((r) => `${r.ratio.toFixed(3)} ${r.name}`)
				.join("; ")}`;
			expect(
				rows.filter((r) => r.ratio < 0.25).map((r) => `${r.ratio.toFixed(3)} ${r.name}`),
				lowest,
			).toEqual([]);
			expect(rows.filter((r) => r.ratio < 0.5).length, lowest).toBeLessThanOrEqual(KNOWN.marginal);
			expect(rows[0].ratio, lowest).toBeGreaterThanOrEqual(KNOWN.lowest);
		},
		full ? 5_400_000 : 1_800_000,
	);
});
