/**
 * E3.5: the growth check's floor (textTokensFloor) against real tokens, over a seeded sweep of honest text
 * (floor-sweep-cases.ts). Real tokens over the floor must be 0.5 or more for every case, with o200k and with
 * GLM-5.3-Flash as E2 counts them; below that, an honest append can read as more than half missing.
 *
 * The default run takes the generated cases at 1,000 and 10,000 characters and every named case.
 * FLOOR_SWEEP_FULL=1 adds 100,000 characters (about 30 minutes). FLOOR_SWEEP_REPORT=<file> writes every ratio there.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { textTokensFloor } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
import { loadTokenizer } from "../context-engine-e2/tokenizers.ts";
import { generatedCases, namedCases, SWEEP_SIZES } from "./floor-sweep-cases.ts";
import { fastO200k, reference } from "./o200k-fast.ts";

const full = process.env.FLOOR_SWEEP_FULL === "1";
const sizes = full ? SWEEP_SIZES : SWEEP_SIZES.filter((s) => s <= 10_000);

describe("E3.5: the floor holds for honest text, over a seeded sweep", () => {
	it("the heap merge counts o200k as js-tiktoken does", () => {
		const texts = [...namedCases(), ...generatedCases([1_000])]
			.filter((_, i) => i % 53 === 0)
			.map((c) => c.text().slice(0, 1_000));
		expect(texts.length).toBeGreaterThan(40);
		for (const t of texts)
			expect(fastO200k(t), JSON.stringify(t.slice(0, 40))).toBe(reference.encode(t, "all").length);
	});

	it(
		"real tokens over the floor are 0.5 or more for every case, with o200k and GLM",
		async () => {
			const glm = await loadTokenizer("glm");
			const rows = [...namedCases(), ...generatedCases(sizes)].map((c) => {
				const text = c.text();
				const floor = textTokensFloor(text);
				const o200k = fastO200k(text);
				const g = glm.count(text);
				return { name: c.name, chars: text.length, floor, o200k, glm: g, ratio: Math.min(o200k, g) / floor };
			});
			rows.sort((a, b) => a.ratio - b.ratio);
			if (process.env.FLOOR_SWEEP_REPORT) writeFileSync(process.env.FLOOR_SWEEP_REPORT, JSON.stringify(rows));
			const below = rows.filter((r) => r.ratio < 0.5);
			expect(
				below.map((r) => `${r.ratio.toFixed(3)} ${r.name}`),
				`lowest: ${rows
					.slice(0, 5)
					.map((r) => `${r.ratio.toFixed(3)} ${r.name}`)
					.join("; ")}`,
			).toEqual([]);
		},
		full ? 3_600_000 : 900_000,
	);
});
