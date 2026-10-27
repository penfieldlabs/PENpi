/**
 * E2 self-test: the simulator and generator do what the README says, independent of the engine's quality.
 *   - real tokenizers load; GLM segment counts add up to tokenizing the whole rendered prompt
 *   - image rules give the published reference values
 *   - the three overflow texts are recognized by Pi's isContextOverflow; what the engine's parseOverflow
 *     reads from them is recorded (informational: an engine property, not a harness property)
 *   - every content class is deterministic, sized, and has its character profile
 *   - end to end: a provider below the engine's band rejects in each style, or truncates silently in
 *     each style, and the engine sees exactly what the simulator reports
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CONTENT_CLASSES, generate } from "./content.ts";
import { loadEngine } from "./engine-under-test.ts";
import { matrixConfigs } from "./matrix.ts";
import { ERROR_STYLES, overflowError } from "./provider-sim.ts";
import { glmImageTokens, glmPromptText, openaiImageTokens, renderRequest } from "./render.ts";
import { outDir, type RunConfig, runOne } from "./runner.ts";
import { recordEngine } from "./suite.ts";
import { CountingTokenizer, loadTokenizer } from "./tokenizers.ts";

const engine = await loadEngine();
const results: Record<string, unknown> = { engine: { label: engine.label, sha256: engine.sha256 } };

function sampleContext(): TranscriptContext {
	const png = generate("image", 2_000, 1).images?.[0];
	const messages = [
		{
			role: "system",
			content: "You are a coding agent. Use the tools.",
			toolsAdded: [
				{
					name: "read_file",
					description: "Read a file.",
					parameters: {
						type: "object",
						properties: { path: { type: "string", description: "Path." } },
						required: ["path"],
					},
				},
			],
			timestamp: 0,
		},
		{ role: "user", content: "请检查这个模块。Check the module and the logs, then report.", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Let me read it." },
				{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", id: "c2", name: "read_file", arguments: { path: "src/b.ts" } },
			],
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read_file",
			content: [{ type: "text", text: generate("code", 3_000, 2).text }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "read_file",
			content: [{ type: "text", text: generate("ja", 1_500, 3).text }, ...(png ? [png] : [])],
			isError: false,
			timestamp: 4,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "  Done: both files read.  " }],
			stopReason: "stop",
			timestamp: 5,
		},
	];
	return { messages } as unknown as TranscriptContext;
}

describe("E2 self-test", () => {
	it("E2_REASONING_COUNT=ignored also sets the model's replayedReasoning, in reasoning runs only", () => {
		const saved = { count: process.env.E2_REASONING_COUNT, modes: process.env.E2_MODES };
		try {
			process.env.E2_REASONING_COUNT = "ignored";
			process.env.E2_MODES = "reject,reasoning";
			const configs = matrixConfigs("coding");
			const reasoning = configs.filter((c) => c.mode === "reasoning");
			expect(reasoning.length).toBeGreaterThan(0);
			for (const c of reasoning)
				expect(c.engineOptions.replayedReasoning).toEqual({ [`faux/e2-${c.window}`]: "ignored" });
			for (const c of configs.filter((c) => c.mode !== "reasoning"))
				expect(c.engineOptions.replayedReasoning).toBeUndefined();
		} finally {
			for (const [k, v] of [
				["E2_REASONING_COUNT", saved.count],
				["E2_MODES", saved.modes],
			] as const)
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
		}
	});

	it("tokenizers load and count", async () => {
		const o200k = await loadTokenizer("o200k");
		const glm = await loadTokenizer("glm");
		expect(o200k.count("hello world")).toBe(2);
		expect(glm.count("[gMASK]<sop><|user|>")).toBe(3);
		results.tokenizers = { o200k: o200k.source, glm: glm.source };
	});

	it("GLM segments add up to the whole rendered prompt", async () => {
		const tok = new CountingTokenizer(await loadTokenizer("glm"));
		const context = sampleContext();
		const rendered = renderRequest(context, "glm", tok);
		const whole = tok.tokenizer.count(glmPromptText(context));
		expect(rendered.tokens - rendered.imageTokens).toBe(whole);
		const o = renderRequest(context, "o200k", new CountingTokenizer(await loadTokenizer("o200k")));
		results.additivity = {
			glmSegments: rendered.tokens - rendered.imageTokens,
			glmWholePrompt: whole,
			glmImageTokens: rendered.imageTokens,
			o200kTotal: o.tokens,
			o200kImageTokens: o.imageTokens,
			segments: rendered.segments.map((s) => `${s.role}:${s.tokens}`),
		};
	});

	it("image rules match their published reference values", () => {
		expect(openaiImageTokens(1024, 1024)).toBe(765);
		expect(openaiImageTokens(2048, 4096)).toBe(1105);
		expect(openaiImageTokens(512, 512)).toBe(255);
		expect(glmImageTokens(200, 200)).toBe(7 * 7 + 2);
		expect(glmImageTokens(50, 50)).toBe(16 + 2);
		expect(glmImageTokens(4000, 4000)).toBeLessThanOrEqual(8_000 + 2);
		results.images = {
			"1600x1442": {
				openai: openaiImageTokens(1600, 1442),
				glm: glmImageTokens(1600, 1442),
				anthropic: Math.min(1600, Math.ceil((1600 * 1442) / 750)),
			},
		};
	});

	it("overflow texts: Pi recognizes all three styles (engine parsing recorded)", () => {
		const parsed: Record<string, unknown> = {};
		for (const style of ERROR_STYLES) {
			const text = overflowError(style, 40_123, 32_768);
			const message = {
				role: "assistant",
				stopReason: "error",
				errorMessage: text,
				content: [],
				usage: {},
			} as unknown as AssistantMessage;
			expect(isContextOverflow(message)).toBe(true);
			const p = engine.parseOverflow?.(text);
			const expected = style === "none" ? {} : { limit: 32_768, requested: 40_123 };
			parsed[style] = {
				text,
				engineParsed: p,
				engineReadsAllNumbers: p
					? JSON.stringify({ ...expected }) ===
						JSON.stringify(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)))
					: null,
			};
		}
		results.errorStyles = parsed;
	});

	it("content classes are deterministic, sized and shaped", () => {
		const profile: Record<string, unknown> = {};
		for (const kind of CONTENT_CLASSES) {
			for (const size of [1_000, 50_000]) {
				const a = generate(kind, size, 42);
				const b = generate(kind, size, 42);
				expect(a.text).toBe(b.text);
				if (kind !== "image") {
					expect(a.text.length).toBeLessThanOrEqual(size);
					expect(a.text.length).toBeGreaterThanOrEqual(size * 0.85);
				} else expect(a.images?.length).toBeGreaterThan(0);
				if (size === 50_000) {
					const t = a.text;
					const share = (re: RegExp) =>
						+((t.match(re) ?? []).reduce((n, m) => n + m.length, 0) / Math.max(1, t.length)).toFixed(3);
					profile[kind] = {
						chars: t.length,
						whitespace: share(/\s/g),
						cjk: share(/[぀-ヿ㐀-鿿]/g),
						base64Run: share(/[A-Za-z0-9+/=]{48,}/g),
						source: a.source,
					};
				}
			}
		}
		expect((profile.whitespace as { whitespace: number }).whitespace).toBeGreaterThan(0.35);
		expect((profile.zh as { cjk: number }).cjk).toBeGreaterThan(0.6);
		expect((profile.ja as { cjk: number }).cjk).toBeGreaterThan(0.6);
		expect((profile.base64 as { base64Run: number }).base64Run).toBeGreaterThan(0.9);
		results.contentProfile = profile;
	});

	const base = (overrides: Partial<RunConfig>): RunConfig => ({
		id: "selftest",
		mix: "coding",
		tokenizer: "o200k",
		window: "32k",
		mode: "reject",
		turns: 60,
		seed: 7,
		errorStyle: "anthropic",
		truncation: "front",
		limit: 16_384,
		limitRule: "self-test: provider limit below the engine's band",
		engineOptions: {},
		...overrides,
	});

	for (const style of ERROR_STYLES) {
		it(`end to end: rejections in the ${style} style reach the engine`, async () => {
			const { metrics } = await runOne(engine, base({ id: `selftest.reject.${style}`, errorStyle: style }));
			expect(metrics.alignment.ok).toBe(true);
			expect(metrics.rejections.count).toBeGreaterThan(0);
			expect(metrics.rejections.firstErrorText).toBe(
				overflowError(
					style,
					Number(metrics.series.tokens[metrics.rejections.at[0]]),
					16_384,
					metrics.rejections.at[0],
				),
			);
			results[`reject.${style}`] = {
				rejections: metrics.rejections.at,
				answered: metrics.session.answeredTurns,
				abandoned: metrics.session.abandonedTurns,
				learnedWindows: metrics.engineStats.learnedWindows,
				overflowRetries: metrics.engineStats.overflowRetries,
				// Informational: the C1 rule for an overstated window (provider limit below the declared window).
				c1: metrics.criteria.find((c) => c.id.startsWith("C1")),
			};
		});
	}

	it("end to end: silent truncation (front) reports exactly the server's limit as usage", async () => {
		const { metrics } = await runOne(engine, base({ id: "selftest.silent-front", mode: "silent-front" }));
		expect(metrics.alignment.ok).toBe(true);
		expect(metrics.silent?.truncated).toBeGreaterThan(0);
		expect(metrics.rejections.count).toBe(0);
		for (const i of metrics.silent?.at ?? []) expect(metrics.series.reported[i]).toBe(16_384);
		results["silent-front"] = {
			truncatedAt: metrics.silent?.at,
			reportedAtTruncated: metrics.silent?.at.map((i) => metrics.series.reported[i]),
			engineDetectedAt: metrics.silent?.engineDetectedAt,
			plateaus: metrics.engineStats.plateaus,
		};
	});

	it("end to end: silent truncation (messages) reports the real remainder as usage", async () => {
		const { metrics } = await runOne(
			engine,
			base({ id: "selftest.silent-messages", mode: "silent-messages", truncation: "messages" }),
		);
		expect(metrics.alignment.ok).toBe(true);
		expect(metrics.silent?.truncated).toBeGreaterThan(0);
		const at = metrics.silent?.at ?? [];
		for (const i of at) {
			const reported = metrics.series.reported[i] as number;
			expect(reported).toBeLessThan(metrics.series.tokens[i]);
			expect(reported).toBeLessThanOrEqual(16_384);
		}
		results["silent-messages"] = {
			truncatedAt: at,
			reportedAtTruncated: at.map((i) => metrics.series.reported[i]),
			engineDetectedAt: metrics.silent?.engineDetectedAt,
			plateaus: metrics.engineStats.plateaus,
		};
		writeFileSync(join(recordEngine(engine), "selftest.json"), JSON.stringify(results, null, 2));
		console.log(`[E2] self-test results -> ${join(outDir(engine), "selftest.json")}`);
	});
});
