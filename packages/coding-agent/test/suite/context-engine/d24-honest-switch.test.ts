/**
 * D24: a provider switch judges the span against the floor. Two upstream providers sit behind a router (OpenRouter),
 * and both are honest: each counts every request with the same real tokenizer (E2's simulator), accepts everything up
 * to the declared 200,000 tokens and cuts nothing. The session reads source files of this repository, then output the
 * estimate prices far above its real tokens: the dot report of `python -m unittest` and base64 of a zero-filled file.
 *
 * At a switch, a sample is judged against the serving provider's own last sample in the same append chain, and the
 * span between them is a chain sum. That sum kept no floor, so the span was judged against the estimate times the full
 * ratio: 16,000 dots are about 10,000 estimated tokens and a few hundred real ones. Sessions 1 and 3 read as a strong
 * sample at the next judged one, and session 2 as an evidence sample and a marginal one with o200k (ADR 0033's pair)
 * and as one strong sample with GLM, and the engine learned a window of about 69,000 to 71,000. The chain now sums the
 * floor's slack beside the text, and the span is judged as a plain append is. The controls passed before: one
 * provider, and the same switches with more source instead.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { installProviderSim } from "../context-engine-e2/provider-sim.ts";
import { CountingTokenizer, loadTokenizer, TOKENIZERS } from "../context-engine-e2/tokenizers.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { blobExtension, finalTurn, scriptedModel } from "./helpers.ts";

const harnesses: Harness[] = [];
const WINDOW = 200_000;
const SOURCE = 8_000;
/** Source files read before the output under test: about 70,000 real tokens. */
const BEFORE = 35;
/** Then small ones, as a session reads a function or two at a time. */
const SMALL = 1_500;
/** The request that carries the first step after them (request 0 is the prompt, request n + 1 step n's result). */
const AT = BEFORE + 1;

// Source files of this repository, cut into pieces of 8,000 characters.
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const code = tracked
	.split("\n")
	.filter((f) => /^packages\/coding-agent\/src\/.*\.ts$/.test(f))
	.map((f) => readFileSync(`${root}${f}`, "utf8"))
	.join("\n");
const source = (i: number) => code.slice(i * SOURCE, (i + 1) * SOURCE);
const small = (i: number) => code.slice(50 * SOURCE + i * SMALL, 50 * SOURCE + (i + 1) * SMALL);
if (code.length < 61 * SOURCE) throw new Error(`d24-honest-switch: ${code.length} characters of source, too few`);

/** What `python -m unittest` prints for that many passing tests. */
const dots = (tests: number) => `${".".repeat(tests)}\n${"-".repeat(70)}\nRan ${tests} tests in 41.237s\n\nOK\n`;
/** `base64` of a zero-filled file of that many bytes, in lines of 76. */
const zeros = (bytes: number) => `${Buffer.alloc(bytes).toString("base64").replace(/.{76}/g, "$&\n")}\n`;

type Router = (call: number) => string;
const first: Router = () => "First";
const alternate: Router = (call) => (call % 2 === 1 ? "Second" : "First");
const secondAt =
	(...calls: number[]): Router =>
	(call) =>
		calls.includes(call) ? "Second" : "First";

/** BEFORE source files, the given steps, then small source files to the end. */
function script(...steps: string[]): Record<string, string> {
	const blobs: Record<string, string> = {};
	for (let i = 0; i < BEFORE; i++) blobs[`src${i}`] = source(i);
	for (const [i, text] of steps.entries()) blobs[`step${i}`] = text;
	for (let i = 0; i < 6; i++) blobs[`small${i}`] = small(i);
	return blobs;
}

async function session(tokenizer: (typeof TOKENIZERS)[number], blobs: Record<string, string>, router: Router) {
	const stats = newStats();
	const lines: string[] = [];
	const notices: string[] = [];
	const harness = await createHarness({
		models: [{ id: "router", contextWindow: WINDOW, maxTokens: 8_000 }],
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
	// The router names the provider serving each call in its stream (OpenRouter's top-level `provider` field).
	const agent = harness.session.agent;
	const counted = agent.streamFunction;
	let call = 0;
	agent.streamFunction = async (model, context, options) => {
		await harness.session.extensionRunner.emit({
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
			data: { id: `gen-${call}`, provider: router(call++), model: model.id },
		});
		return counted(model, context, options);
	};
	const model = scriptedModel(harness);
	Object.keys(blobs).forEach((blob, n) => {
		model.push(() =>
			fauxAssistantMessage(
				[fauxText("Reading the next file."), fauxToolCall("blob", { name: blob }, { id: `call-${n}` })],
				{ stopReason: "toolUse" },
			),
		);
	});
	model.push(finalTurn("All done."));
	await harness.session.prompt("Read the sources and the test output, then report.");
	return { stats, lines, notices, sim };
}

/** The provider truncated and rejected nothing, and the engine reported no truncation and learned no window. */
function expectHonest(r: Awaited<ReturnType<typeof session>>) {
	expect(r.sim.calls.filter((c) => c.truncated || c.rejected)).toHaveLength(0);
	expect(
		r.stats.plateaus,
		r.lines.filter((l) => /silent truncation|serving provider/.test(l)).join("\n"),
	).toHaveLength(0);
	expect(r.notices.filter((n) => n.includes("silently truncated"))).toHaveLength(0);
	expect(r.stats.lastLimits?.window).toBe(WINDOW);
}

/** At least one switch sample was judged against the provider's own earlier sample. */
function expectJudged(r: Awaited<ReturnType<typeof session>>) {
	expect(r.lines.some((l) => /serving provider changed \(\w+ -> \w+\): judged against/.test(l))).toBe(true);
}

describe("D24: honest providers behind a router, output the estimate prices far above its real tokens", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const tokenizer of TOKENIZERS) {
		it(`${tokenizer}, control: one provider, a dot report of 16,000 tests, then base64 of a zero-filled file`, async () => {
			const r = await session(tokenizer, script(dots(16_000), zeros(6_000)), first);
			expect(r.lines.filter((l) => l.includes("serving provider changed"))).toEqual([]);
			expectHonest(r);
		});

		it(`${tokenizer}, control: one request on the second provider, more source`, async () => {
			const r = await session(tokenizer, script(source(40), small(10)), secondAt(AT));
			expectJudged(r);
			expectHonest(r);
		});

		it(`${tokenizer}, control: the providers alternate, more source`, async () => {
			const r = await session(tokenizer, script(source(40), small(10)), alternate);
			expectJudged(r);
			expectHonest(r);
		});

		it(`${tokenizer}, 1: one request on the second provider carries a dot report of 16,000 tests`, async () => {
			const r = await session(tokenizer, script(dots(16_000)), secondAt(AT));
			expectJudged(r);
			expectHonest(r);
		});

		it(`${tokenizer}, 2: two requests on the second provider, a dot report of 8,000 tests, then base64 of a zero-filled file`, async () => {
			const r = await session(
				tokenizer,
				script(dots(8_000), code.slice(60 * SOURCE, 61 * SOURCE - 5_000), zeros(6_000)),
				secondAt(AT, AT + 2),
			);
			expectJudged(r);
			expectHonest(r);
		});

		it(`${tokenizer}, 3: the providers alternate on every request, a dot report of 16,000 tests`, async () => {
			const r = await session(tokenizer, script(dots(16_000)), alternate);
			expectJudged(r);
			expectHonest(r);
		});
	}
});
