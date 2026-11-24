/**
 * E3.5: the floor sweep counted with Claude's own tokenizer, re-priced with the checkout's floor, offline. Anthropic's
 * token counter counted every case on every Claude model Pi lists (floor-sweep-claude.mjs, ADR 0033), and the models
 * fall into groups that count the whole sweep alike. claude-counts.txt holds one row per case of the full sweep: the
 * first 8 hex digits of the case text's SHA-256, then Claude's real tokens for each group ("=": as the group before).
 * A case whose text has no row (a new or changed case) is not counted, and the test says to count it. Below 0.25 of
 * the floor an honest append reads as evidence of truncation: no case may. Between 0.25 and 0.5 it reads marginal, and
 * each group's band is pinned for each sweep size, as floor-sweep.test.ts pins o200k's and GLM's: the test fails if
 * more cases of a group fall below 0.5, or any below its lowest.
 *
 * The cases that take text from repository files read frozen copies (floor-sweep-texts/), so every case is
 * checked, on stock upstream too.
 *
 * The default run checks the cases of the default sweep (npm test); FLOOR_SWEEP_FULL=1 checks the full one (CI's
 * engine-on-upstream job).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { textTokensFloor } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
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

const here = dirname(fileURLToPath(import.meta.url));
const full = process.env.FLOOR_SWEEP_FULL === "1";
const sizes = full ? SWEEP_SIZES : SWEEP_SIZES.filter((s) => s <= 10_000);
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
/**
 * Each group's band as measured at 0.8.0, by the group's first model: the cases below 0.5 of the floor, and the lowest
 * ratio (63 units of CR after counter lines for the first two groups, 1 unit of CRLF for the other two). Both sweep
 * sizes read alike, since the cases the full sweep adds read above 0.5; each keeps its own figures.
 */
const KNOWN: Record<"default" | "full", Record<string, { marginal: number; lowest: number }>> = {
	default: {
		"claude-fable-5": { marginal: 49, lowest: 0.493 },
		"claude-fable-5-1": { marginal: 49, lowest: 0.493 },
		"claude-haiku-4-5": { marginal: 12, lowest: 0.498 },
		"claude-opus-4-7": { marginal: 12, lowest: 0.498 },
	},
	full: {
		"claude-fable-5": { marginal: 49, lowest: 0.493 },
		"claude-fable-5-1": { marginal: 49, lowest: 0.493 },
		"claude-haiku-4-5": { marginal: 12, lowest: 0.498 },
		"claude-opus-4-7": { marginal: 12, lowest: 0.498 },
	},
};

/** The groups and each case's counts by text hash, from claude-counts.txt. */
function loadCounts(): { groups: string[][]; counts: Map<string, number[]> } {
	const lines = readFileSync(join(here, "claude-counts.txt"), "utf8").split("\n");
	const groups: string[][] = [];
	const counts = new Map<string, number[]>();
	for (const line of lines) {
		if (line.startsWith("# group ")) groups.push(line.slice("# group ".length).split(" "));
		if (!line || line.startsWith("#")) continue;
		const [hash, ...reals] = line.split(" ");
		// "=": the same as the group before.
		const values: number[] = [];
		for (const r of reals) values.push(r === "=" ? values[values.length - 1] : Number(r));
		const known = counts.get(hash);
		// Two texts with one hash and different counts cannot be told apart: count them again with a longer hash.
		if (known && known.join() !== values.join()) throw new Error(`two cases share the hash ${hash}`);
		counts.set(hash, values);
	}
	return { groups, counts };
}

describe("E3.5: the floor holds for honest text counted with Claude, over the seeded sweep", () => {
	const { groups, counts } = loadCounts();
	const cases = [
		...recheckCases(),
		...thirdRecheckCases(),
		...fourthRecheckCases(),
		...fifthRecheckCases(),
		...namedCases(),
		...whitespaceCases(),
		...markerLineCases(),
		...markerPlaceCases(),
		...nonAsciiRunCases(),
		...generatedCases(sizes),
	];
	it(
		"no case is below 0.25 of the floor in any group of Claude models, the marginal cases are no more and no lower than known, and every case is counted",
		() => {
			const known = KNOWN[full ? "full" : "default"];
			expect(
				groups.map((g) => g[0]),
				"the groups changed: measure each group's band and pin it",
			).toEqual(Object.keys(known));
			const missing: string[] = [];
			const below: string[] = [];
			let lowest = { ratio: Number.POSITIVE_INFINITY, name: "" };
			const band = groups.map(() => ({ marginal: 0, ratio: Number.POSITIVE_INFINITY, name: "" }));
			for (const c of cases) {
				const text = c.text();
				const reals = counts.get(hashOf(text));
				if (!reals) {
					missing.push(c.name);
					continue;
				}
				const floor = textTokensFloor(text);
				reals.forEach((real, g) => {
					// A case Claude counts at 0 whose floor is 0 reads 1.
					const ratio = floor === 0 ? (real <= 0 ? 1 : Number.POSITIVE_INFINITY) : real / floor;
					if (ratio < 0.25) below.push(`${ratio.toFixed(3)} ${groups[g][0]} ${c.name}`);
					if (ratio < lowest.ratio) lowest = { ratio, name: `${groups[g][0]} ${c.name}` };
					if (ratio < 0.5) band[g].marginal++;
					if (ratio < band[g].ratio) band[g] = { ...band[g], ratio, name: c.name };
				});
			}
			expect(
				missing.slice(0, 10),
				`${missing.length} case(s) of the sweep have no Claude count: count them with ` +
					"floor-sweep-claude.mjs (sweep, then export; see floor-sweep-claude.md)",
			).toEqual([]);
			expect(below, `lowest: ${lowest.ratio.toFixed(3)} ${lowest.name}`).toEqual([]);
			groups.forEach((g, i) => {
				const { marginal, ratio, name } = band[i];
				const at = `${g[0]}: lowest ${ratio.toFixed(4)} ${name}`;
				expect(marginal, at).toBeLessThanOrEqual(known[g[0]].marginal);
				expect(ratio, at).toBeGreaterThanOrEqual(known[g[0]].lowest);
			});
		},
		full ? 1_800_000 : 600_000,
	);
});
