/**
 * 0.8.0: the E2 corpus is pinned apart from the upstream base. The v1.5.1 merge moved the `base:` line of
 * docs/UPSTREAM_PATCHES.txt, which was also the corpus revision, so every E2 run changed with the merge and code and
 * corpus could not be told apart. The `e2-corpus:` line records the revision and its fingerprint; a run at that
 * revision fails on another fingerprint.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corpusPinMismatch, hasCommit, loadCorpus, parseCorpusPin, REPO_ROOT, resolveRev } from "./corpus.ts";

const REV = "dd30101cfc5b0609411dd80b6f93adbc14db14cf";
const PRINT = "e917a3cbd38a1bd6ae8bb72a99be52fe5761ff224ada1908c747a12a015464ab";
const manifest = readFileSync(join(REPO_ROOT, "docs", "UPSTREAM_PATCHES.txt"), "utf8");

describe("E2 corpus pin", () => {
	it("the manifest pins upstream v1.5.1 and its fingerprint, apart from the base line", () => {
		expect(parseCorpusPin(manifest)).toEqual({ rev: REV, fingerprint: PRINT });
		expect(/^base: /m.test(manifest)).toBe(true);
		expect(parseCorpusPin(`base: ${REV}\n`)).toBeUndefined();
		expect(parseCorpusPin(`e2-corpus: ${REV}\n`)).toBeUndefined();
	});

	it("a corpus at the pinned revision must have the pinned fingerprint; another revision is not checked", () => {
		const pin = { rev: REV, fingerprint: PRINT };
		expect(corpusPinMismatch(pin, REV, PRINT)).toBeUndefined();
		expect(corpusPinMismatch(pin, REV, "0".repeat(64))).toMatch(
			/has fingerprint 000000000000, but the e2-corpus: line/,
		);
		expect(corpusPinMismatch(pin, "f".repeat(40), "0".repeat(64))).toBeUndefined();
	});

	// A shallow clone (CI's main job checks out at depth 1) lacks the pinned commit. The test then skips, saying why;
	// engine-on-upstream and the release workflow check out the full history and run it.
	const present = hasCommit(REV);
	const another = process.env.E2_CORPUS_REV !== undefined && process.env.E2_CORPUS_REV !== "";
	const why = !present
		? ` (skipped: ${REV.slice(0, 12)} is not in this clone; a shallow checkout. engine-on-upstream and release.yml run it)`
		: another
			? " (skipped: E2_CORPUS_REV asks for another revision, so nothing pinned to compare)"
			: "";
	// The two full-history jobs set E2_PIN_REQUIRED, so a missing commit, or another revision asked for, fails there
	// instead of skipping the fingerprint test.
	it.runIf((!present || another) && process.env.E2_PIN_REQUIRED === "1")(
		"E2_PIN_REQUIRED=1 (a full-history job) and the fingerprint test would skip: fail",
		() => {
			expect.fail(
				!present
					? `${REV} is not in this clone, and E2_PIN_REQUIRED=1: check out with fetch-depth: 0`
					: "E2_CORPUS_REV is set, and E2_PIN_REQUIRED=1: the pin check needs the pinned revision",
			);
		},
	);

	it.skipIf(!present || another)(
		`the corpus built from the pinned revision has the pinned fingerprint${why}`,
		{ timeout: 300_000 },
		() => {
			const corpus = loadCorpus();
			expect(corpus.rev).toBe(REV);
			expect(corpus.fingerprint).toBe(PRINT);
		},
	);

	it.skipIf(!present)("the pin check sees the pinned commit through a short id", () => {
		expect(resolveRev(REV.slice(0, 9))).toBe(REV);
		const pin = { rev: REV, fingerprint: PRINT };
		expect(corpusPinMismatch(pin, resolveRev(REV.slice(0, 9)), "0".repeat(64))).toBeDefined();
	});
});
