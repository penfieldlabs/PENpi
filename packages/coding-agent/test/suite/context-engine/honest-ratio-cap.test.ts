/**
 * E3.5: a session ratio above 1 does not inflate the growth check's floor. An honest provider is never reported as
 * truncating when output the estimate undercounts lifts the session ratio to about 3, and the session then reads
 * text whose real tokens are among the lowest of the floor sweep (floor-sweep-cases.ts).
 *
 * The provider counts every request with a real tokenizer (E2's simulator), accepts everything up to the declared
 * window and never truncates. The session reads source maps, whose mappings the estimate prices at about a third of
 * their real tokens, then marker and bracket lines that read 0.34 to 0.43 of the floor. The floor prices text near
 * what tokenizers count, so its judged growth takes the session ratio at most 1: those appends read marginal at
 * worst. With the full ratio of about 2.9 they read 0.13 to 0.21 of it, evidence: with o200k the first was strong and
 * detected at once, with GLM the first two detected, and the engine learned a window of about 110,000 tokens.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { installProviderSim } from "../context-engine-e2/provider-sim.ts";
import { CountingTokenizer, loadTokenizer, TOKENIZERS } from "../context-engine-e2/tokenizers.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { markerPlaceCases } from "./floor-sweep-cases.ts";
import { blobExtension, finalTurn, rng, scriptedModel } from "./helpers.ts";

const harnesses: Harness[] = [];
const WINDOW = 200_000;
const MAPS = 14;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A source map of about `size` characters: a few names and sources, then mappings of base64 VLQ segments. */
function sourceMap(seed: number, size: number): string {
	const r = rng(seed);
	const segment = () =>
		Array.from({ length: r() < 0.6 ? 4 : 5 }, () => B64[Math.floor(r() * (r() < 0.9 ? 16 : 64))]).join("");
	let mappings = "";
	while (mappings.length < size) {
		const line = Array.from({ length: 4 + Math.floor(r() * 12) }, segment).join(",");
		mappings += `${line};`;
	}
	const sources = Array.from({ length: 6 }, (_, i) => `"../src/module${seed}-${i}.ts"`).join(",");
	return `{"version":3,"file":"bundle${seed}.js","sources":[${sources}],"names":["init","state","render","update"],"mappings":"${mappings}"}\n`;
}

/** The sweep's lowest shapes, at about 16,000 characters each. */
const LOWEST = [
	'counter, a space, "-->", 1 to 3 breaks, LF',
	'counter, a space, "*/", 1 to 3 breaks, LF',
	'counter, a space, "-->", 1 to 3 breaks, CRLF',
	'"});", a break, 0 to 40 spaces of indentation, CRLF',
];
const cases = markerPlaceCases(16_000);
const lowest = LOWEST.map((name) => {
	const c = cases.find((x) => x.name === name);
	if (!c) throw new Error(`honest-ratio-cap: no sweep case named ${name}`);
	return c.text();
});

async function session(tokenizer: (typeof TOKENIZERS)[number]) {
	const stats = newStats();
	const lines: string[] = [];
	const notices: string[] = [];
	// Fourteen source maps of about 12,000 characters, then the low shapes.
	const blobs: Record<string, string> = {};
	for (let i = 0; i < MAPS; i++) blobs[`map${i}`] = sourceMap(i + 1, 12_000);
	for (const [i, text] of lowest.entries()) blobs[`low${i}`] = text;
	const steps = Object.keys(blobs);
	const harness = await createHarness({
		models: [{ id: "honest", contextWindow: WINDOW, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			blobExtension(Object.fromEntries(Object.entries(blobs).map(([k, text]) => [k, { text }]))),
			createContextEngine({ stats, log: (l: string) => lines.push(l) }),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
	// Honest: rejects only above the declared window, never truncates, reports exactly what it counted.
	const sim = installProviderSim(harness, {
		tokenizer,
		counter: new CountingTokenizer(await loadTokenizer(tokenizer)),
		limit: WINDOW,
		mode: "reject",
		errorStyle: "anthropic",
	});
	const model = scriptedModel(harness);
	steps.forEach((blob, n) => {
		model.push(() =>
			fauxAssistantMessage(
				[fauxText("Reading the next file."), fauxToolCall("blob", { name: blob }, { id: `call-${n}` })],
				{
					stopReason: "toolUse",
				},
			),
		);
	});
	model.push(finalTurn("All done."));
	await harness.session.prompt("Read the build output, then report.");
	return { stats, lines, notices, sim };
}

describe("E3.5: an honest provider, a session ratio of about 3, the sweep's lowest shapes", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const tokenizer of TOKENIZERS) {
		it(`${tokenizer}: source maps lift the ratio to 2.75 or more, then marker and bracket lines, no detection`, async () => {
			const r = await session(tokenizer);
			// The ratio the first low-shape append was judged with: the source maps lifted it.
			const ratio = r.stats.sent[MAPS + 1].ratio;
			expect(ratio).toBeGreaterThan(2.75);
			expect(r.sim.calls.filter((c) => c.truncated || c.rejected)).toHaveLength(0);
			expect(r.stats.plateaus, r.lines.filter((l) => l.includes("silent truncation")).join("\n")).toHaveLength(0);
			expect(r.notices.filter((n) => n.includes("silently truncated"))).toHaveLength(0);
			expect(r.stats.lastLimits?.window).toBe(WINDOW);
		});
	}
});
