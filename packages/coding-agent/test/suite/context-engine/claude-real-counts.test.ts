/**
 * 0.9.0: Claude's counts of real tool outputs, against the estimate and the floor (S4). On 73 real outputs Claude
 * counts a median 1.60 times the estimate (1.57 summed), up to 2.87 on file listings, on Haiku 5.5 and Opus 4.7 alike,
 * so a Claude model's ratio prior on the fallback path is 1.6 (CLAUDE_PRIOR), and the floor holds with room.
 *
 * Pinned on twelve of those outputs, repository content only (claude-real-texts/, counts in claude-real-counts.txt):
 * - real over estimate within a band of the prior: 1.2 to 2.0, and up to 3 on paths and listings;
 * - real over floor at least 0.5, so no honest append of these kinds reads as truncation;
 * - the prior within 0.25 of real over estimate summed, on the outputs that aren't paths.
 *
 * The band is for code, config and listings, the outputs a coding session reads most. It is not for every kind of text:
 * S4's other outputs fall below 1.2 (Russian prose at 0.48; xxd, CSV, the engine's rows, sha256sum and a test log at
 * 0.98 to 1.19), and on a first request of Russian text the prior prices about 3.3 times high, which errs on the side
 * of an early cut.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { textTokens, textTokensFloor } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
import { CLAUDE_PRIOR } from "../../../../../.pi/extensions/penpi/engine/state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Outputs that are mostly paths: Claude counts slashes and path segments densely. */
const PATHS = new Set(["git-ls-files", "find", "grep-exports", "grep-n"]);

const rows = readFileSync(join(HERE, "claude-real-counts.txt"), "utf8")
	.split("\n")
	.filter((line) => line && !line.startsWith("#"))
	.map((line) => {
		const [name, haiku, opus] = line.split("\t");
		return {
			name,
			haiku: Number(haiku),
			opus: Number(opus),
			text: readFileSync(join(HERE, "claude-real-texts", `${name}.txt`), "utf8"),
		};
	});

describe("0.9.0: Claude's counts of real tool outputs", () => {
	it("holds twelve outputs, counted on both models", () => {
		expect(rows).toHaveLength(12);
		for (const row of rows) expect(Math.abs(row.haiku - row.opus), row.name).toBeLessThanOrEqual(2);
	});

	for (const model of ["haiku", "opus"] as const) {
		it(`${model}: real over estimate within the prior's band, and real over floor at least 0.5`, () => {
			for (const row of rows) {
				const real = row[model];
				const overEstimate = real / textTokens(row.text);
				const overFloor = real / textTokensFloor(row.text);
				expect(overEstimate, row.name).toBeGreaterThanOrEqual(1.2);
				expect(overEstimate, row.name).toBeLessThanOrEqual(PATHS.has(row.name) ? 3 : 2);
				expect(overFloor, row.name).toBeGreaterThanOrEqual(0.5);
			}
		});
	}

	it("the Claude prior is near what Claude counts over the estimate, summed, on the outputs that aren't paths", () => {
		// Paths and listings run far higher (up to 2.87): the spread a single ratio can't cover, for 0.10.0's price table.
		const prose = rows.filter((r) => !PATHS.has(r.name));
		const real = prose.reduce((sum, r) => sum + r.haiku, 0);
		const estimate = prose.reduce((sum, r) => sum + textTokens(r.text), 0);
		expect(CLAUDE_PRIOR).toBe(1.6);
		expect(Math.abs(real / estimate - CLAUDE_PRIOR)).toBeLessThan(0.25);
	});
});
