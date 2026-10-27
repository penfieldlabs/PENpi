/**
 * H8: the decided window ceiling. The engine plans against min(model window, 200k) unless a per-model
 * override sets the window; learned limits still apply below it. Also covers the status line and the
 * `/penpi doctor` command.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, type EngineOptions, NOTICE_MARKER, newStats } from "./engine.ts";
import {
	analyzePrefixes,
	installProviderSim,
	report,
	runPrompts,
	type ScriptedModel,
	scriptedModel,
	workExtension,
} from "./helpers.ts";

const GLM_REFRESHED = { id: "glm-1m", contextWindow: 1_048_575, maxTokens: 943_717 };
const GLM_FALLBACK = { id: "glm-fallback", contextWindow: 262_144, maxTokens: 262_144 };
const isNotice = (m: string) => NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER);

/** Pins the cwd section of the system prompt, so two harnesses (different temp dirs) send identical prompts. */
function fixedCwd(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.cwd = "/work/project";
	});
}

async function setup(
	model: { id: string; contextWindow: number; maxTokens: number },
	engine: Partial<EngineOptions>,
	sim: Parameters<typeof installProviderSim>[1] = {},
) {
	const stats = newStats();
	const statuses: string[] = [];
	const notices: string[] = [];
	const harness = await createHarness({
		models: [model],
		settings: { compaction: { enabled: false } },
		extensionFactories: [fixedCwd, workExtension, createContextEngine({ stats, ...engine })],
	});
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({
			setStatus: (_key, text) => {
				if (text) statuses.push(text);
			},
			notify: (message) => notices.push(message),
		}),
	});
	return { harness, stats, statuses, notices, sim: installProviderSim(harness, sim), model: scriptedModel(harness) };
}

async function doctor(harness: Harness, notices: string[]): Promise<string> {
	const before = notices.length;
	await harness.session.prompt("/penpi doctor");
	return notices.slice(before).join("\n");
}

/** Big tool results so a session passes 200k tokens within ~60 turns. */
async function heavy(harness: Harness, model: ScriptedModel, prompts: number, turns: number) {
	await runPrompts(harness, model, { prompts, turns, min: 8_000, spread: 12_000 });
}

describe("H8: window ceiling, status line, doctor", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const definition of [GLM_REFRESHED, GLM_FALLBACK]) {
		it(`h8 ${definition.id} (${definition.contextWindow}/${definition.maxTokens}) stays inside the 200k-derived budget and cuts`, async () => {
			const t = await setup(definition, {});
			harnesses.push(t.harness);
			await heavy(t.harness, t.model, 3, 40);
			const text = await doctor(t.harness, t.notices);
			const maxSent = Math.max(...t.sim.calls.map((c) => c.promptTokens));
			const limits = t.stats.lastLimits;
			report("h8", ENGINE_LABEL, `ceiling.${definition.id}`, {
				calls: t.sim.calls.length,
				maxSent,
				limits,
				cuts: t.stats.cuts.length,
				status: t.statuses.at(-1),
				doctor: text,
			});
			// Budget = 200,000 - min(16,384 default output, 40,000) = 183,616.
			expect(limits?.window).toBe(200_000);
			expect(limits?.budget).toBe(183_616);
			expect(maxSent).toBeLessThanOrEqual(183_616);
			expect(t.stats.cuts.length).toBeGreaterThan(0);
			expect(t.statuses.at(-1)).toMatch(/^ctx 200k \(model (1\.05M|262k), ceiling\)/);
			expect(text).toContain("effective window: 200,000 (reason: ceiling");
			expect(text).toContain("band: cut above 137,712, cut down to 82,627");
			expect(text).toContain("compaction.enabled is false: yes");
		});
	}

	it("h8 the ceiling disabled restores full-window planning", async () => {
		for (const windowCeiling of [0, null]) {
			const t = await setup(GLM_REFRESHED, { windowCeiling });
			harnesses.push(t.harness);
			await heavy(t.harness, t.model, 3, 40);
			const text = await doctor(t.harness, t.notices);
			const maxSent = Math.max(...t.sim.calls.map((c) => c.promptTokens));
			report("h8", ENGINE_LABEL, `no-ceiling.${windowCeiling}`, {
				maxSent,
				limits: t.stats.lastLimits,
				cuts: t.stats.cuts.length,
				doctor: text,
			});
			expect(t.stats.lastLimits?.window).toBe(1_048_575);
			expect(t.stats.lastLimits?.reason).toBe("metadata(unverified)");
			expect(maxSent).toBeGreaterThan(200_000);
			expect(t.stats.cuts).toHaveLength(0);
			expect(text).toContain("effective window: 1,048,575 (reason: metadata(unverified); ceiling off");
		}
	});

	it("h8 a 128k model is byte-for-byte the same with and without the ceiling", async () => {
		const runs: Array<{ requests: string[][]; tokens: number[]; cuts: number }> = [];
		for (const windowCeiling of [200_000, 0]) {
			const t = await setup({ id: "m128k", contextWindow: 128_000, maxTokens: 16_000 }, { windowCeiling });
			harnesses.push(t.harness);
			await runPrompts(t.harness, t.model, { prompts: 3, turns: 30, min: 4_000, spread: 8_000 });
			// Entry ids are random per session (and an id's characters move the engine's estimate by about
			// 1 token, which shows only in the notice's "about N tokens"); nothing else may differ. The cwd
			// section of the system prompt is pinned.
			const normalize = (m: string) =>
				m.replace(/\b[0-9a-f]{8}\b/g, "<id>").replace(/In about \d+ tokens/, "In about <n> tokens");
			runs.push({
				requests: t.model.requests.map((r) => r.map(normalize)),
				tokens: t.model.promptTokens,
				cuts: t.stats.cuts.length,
				sent: t.stats.sent.map((x) => [x.estimate, +x.ratio.toFixed(6)]),
				limits: t.stats.lastLimits,
			} as never);
		}
		const [capped, uncapped] = runs;
		const firstDifference = capped.requests.findIndex(
			(r, i) => JSON.stringify(r) !== JSON.stringify(uncapped.requests[i]),
		);
		if (firstDifference >= 0) {
			const a = capped.requests[firstDifference];
			const b = uncapped.requests[firstDifference];
			const at = a.findIndex((m, i) => m !== b[i]);
			const sa = (capped as unknown as { sent: number[][] }).sent;
			const sb = (uncapped as unknown as { sent: number[][] }).sent;
			const sentDiff = sa.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(sb[i]));
			report("h8", ENGINE_LABEL, "128k-first-difference", {
				sentDiff,
				sentA: sa.slice(Math.max(0, sentDiff - 1), sentDiff + 2),
				sentB: sb.slice(Math.max(0, sentDiff - 1), sentDiff + 2),
				tokensDiff: capped.tokens.findIndex((x, i) => x !== uncapped.tokens[i]),
				request: firstDifference,
				message: at,
				capped: a[at]?.slice(0, 400),
				uncapped: b[at]?.slice(0, 400),
				lengths: [a.length, b.length],
			});
		}
		report("h8", ENGINE_LABEL, "128k-identical", {
			requests: [capped.requests.length, uncapped.requests.length],
			cuts: [capped.cuts, uncapped.cuts],
			firstDifference,
			maxTokens: [Math.max(...capped.tokens), Math.max(...uncapped.tokens)],
		});
		expect(capped.cuts).toBeGreaterThan(0);
		expect(capped.requests.length).toBe(uncapped.requests.length);
		expect(firstDifference).toBe(-1);
		expect(capped.cuts).toBe(uncapped.cuts);
		expect(capped.tokens).toEqual(uncapped.tokens);
		expect((capped as unknown as { limits: unknown }).limits).toEqual(
			(uncapped as unknown as { limits: unknown }).limits,
		);
	});

	it("h8 precedence: a per-model window override beats the ceiling; a maxTokens-only override does not", async () => {
		const window = await setup(GLM_REFRESHED, {
			limitOverrides: { "faux/glm-1m": { contextWindow: 400_000, maxTokens: 32_000 } },
		});
		harnesses.push(window.harness);
		await heavy(window.harness, window.model, 3, 40);
		const windowDoctor = await doctor(window.harness, window.notices);
		const outputOnly = await setup(GLM_REFRESHED, { modelLimits: { "faux/glm-1m": { maxTokens: 64_000 } } });
		harnesses.push(outputOnly.harness);
		await heavy(outputOnly.harness, outputOnly.model, 1, 10);
		const outputDoctor = await doctor(outputOnly.harness, outputOnly.notices);
		const maxSent = Math.max(...window.sim.calls.map((c) => c.promptTokens));
		report("h8", ENGINE_LABEL, "precedence", {
			windowOverride: {
				limits: window.stats.lastLimits,
				maxSent,
				cuts: window.stats.cuts.length,
				status: window.statuses.at(-1),
			},
			outputOnlyOverride: { limits: outputOnly.stats.lastLimits, status: outputOnly.statuses.at(-1) },
		});
		expect(window.stats.lastLimits).toMatchObject({
			window: 400_000,
			reason: "override",
			reserve: 32_000,
			budget: 368_000,
		});
		expect(maxSent).toBeGreaterThan(200_000);
		expect(maxSent).toBeLessThanOrEqual(368_000);
		expect(window.statuses.at(-1)).toMatch(/^ctx 400k \(model 1\.05M, override\)/);
		expect(windowDoctor).toContain("effective window: 400,000 (reason: override; ceiling 200,000; override 400,000)");
		// maxTokens alone: the ceiling still caps the window; the reserve is min(64,000, 40,000).
		expect(outputOnly.stats.lastLimits).toMatchObject({
			window: 200_000,
			reason: "ceiling",
			maxOutput: 64_000,
			reserve: 40_000,
		});
		expect(outputDoctor).toContain("max output: 64,000 (override)");
	});

	it("h8 output reserve = min(max output, 20% of the capped window); a request may still ask for more", async () => {
		const cases = [
			// Implausible declared max (943,717 > 75% of the window): max output falls back to 16,384.
			{ model: GLM_REFRESHED, expect: { window: 200_000, reason: "ceiling", maxOutput: 16_384, reserve: 16_384 } },
			// o3-like: 200k is not above the ceiling, so it is unaffected; the reserve is 20% of the window.
			{
				model: { id: "o3-like", contextWindow: 200_000, maxTokens: 100_000 },
				expect: { window: 200_000, reason: "metadata", maxOutput: 100_000, reserve: 40_000 },
			},
			{
				model: { id: "m128k-16k", contextWindow: 128_000, maxTokens: 16_384 },
				expect: { window: 128_000, reason: "metadata", maxOutput: 16_384, reserve: 16_384 },
			},
			{
				model: { id: "m32k-8k", contextWindow: 32_768, maxTokens: 8_192 },
				expect: { window: 32_768, reason: "metadata", maxOutput: 8_192, reserve: 6_553 },
			},
		];
		const rows: Record<string, unknown> = {};
		for (const c of cases) {
			const t = await setup(c.model, {});
			harnesses.push(t.harness);
			await heavy(t.harness, t.model, 2, 40);
			const limits = t.stats.lastLimits!;
			const accepted = t.sim.calls.filter((call) => !call.rejected);
			const sentMax = accepted.map((call) => call.maxTokens ?? 0);
			const largest = accepted.reduce((a, b) => (b.promptTokens > a.promptTokens ? b : a));
			rows[c.model.id] = {
				...limits,
				cuts: t.stats.cuts.length,
				rejected: t.sim.calls.length - accepted.length,
				maxTokensFirst: sentMax[0],
				maxTokensMin: Math.min(...sentMax),
				largestRequest: largest.promptTokens,
				maxTokensAtLargest: largest.maxTokens,
			};
			expect(limits).toMatchObject(c.expect);
			expect(limits.budget).toBe(limits.window - limits.reserve);
			expect(accepted).toHaveLength(t.sim.calls.length);
			// Never squeezed below the reserve, and above it whenever the max output and the room allow.
			expect(Math.min(...sentMax)).toBeGreaterThanOrEqual(limits.reserve);
			expect(sentMax[0]).toBe(limits.maxOutput);
			if (limits.maxOutput > limits.reserve) expect(largest.maxTokens).toBeGreaterThan(limits.reserve);
		}
		report("h8", ENGINE_LABEL, "reserve-formula", rows);
	});

	it("h8 a learned window below the ceiling still applies", async () => {
		const t = await setup(GLM_REFRESHED, {}, { realLimit: 100_000 });
		harnesses.push(t.harness);
		await heavy(t.harness, t.model, 3, 40);
		const text = await doctor(t.harness, t.notices);
		const firstRejection = t.sim.calls.findIndex((c) => c.rejected);
		// Accepted requests after the first rejection (a failed re-probe is rejected and retried smaller).
		const after = t.sim.calls.slice(firstRejection + 1).filter((c) => !c.rejected);
		report("h8", ENGINE_LABEL, "learned-below-ceiling", {
			rejected: t.sim.calls.filter((c) => c.rejected).length,
			rejections: t.sim.calls.flatMap((c, i) => (c.rejected ? [{ call: i, tokens: c.promptTokens }] : [])),
			probes: t.stats.probes,
			learnedWindows: t.stats.learnedWindows,
			maxAfterLearning: Math.max(...after.map((c) => c.promptTokens)),
			limits: t.stats.lastLimits,
			status: t.statuses.at(-1),
			doctor: text,
		});
		expect(t.model.cursor).toBe(120);
		// Below the ceiling (a re-probe may be running toward 200k at the end of the run).
		expect(t.stats.lastLimits?.window).toBeLessThan(200_000);
		expect(t.stats.lastLimits?.reason).toBe("learned(parsed)");
		expect(Math.max(...after.map((c) => c.promptTokens))).toBeLessThanOrEqual(100_000);
		expect(t.statuses.at(-1)).toMatch(/^ctx 1\d\dk \(model 1\.05M, learned\(parsed\)\)/);
		expect(text).toMatch(
			/learned windows:\n {2}faux\/glm-1m: 1\d\d,000 \(parsed; evidence base 100,000; (re-probe toward 200,000|probing at|permanent)/,
		);
	});

	it("h8 a learned window below the ceiling converges: re-probes that fail near it end probing", async () => {
		// The ceiling makes the re-probe target 200k, so a 100k limit re-probes at 150k (band ~100k) and
		// then at 200k. Neither step may retire the limit without a request above 100k succeeding.
		const t = await setup(GLM_REFRESHED, {}, { realLimit: 100_000 });
		harnesses.push(t.harness);
		await heavy(t.harness, t.model, 10, 40);
		const text = await doctor(t.harness, t.notices);
		const rejections = t.sim.calls.flatMap((c, i) => (c.rejected ? [{ call: i, tokens: c.promptTokens }] : []));
		report("h8", ENGINE_LABEL, "learned-converges", {
			calls: t.sim.calls.length,
			rejections,
			probes: t.stats.probes,
			learnedWindows: t.stats.learnedWindows,
			limits: t.stats.lastLimits,
			learnedLine: text.split("\n").find((line) => line.includes("faux/glm-1m:")),
		});
		expect(t.model.cursor).toBe(400);
		// The first rejection teaches 100k; at most probeConfirmations (2) failed re-probes follow.
		expect(rejections.length).toBeLessThanOrEqual(3);
		expect(text).toContain(
			"faux/glm-1m: 100,000 (parsed; evidence base 100,000; permanent after 2 failed re-probes)",
		);
		expect(t.stats.lastLimits).toMatchObject({ window: 100_000, reason: "learned(parsed)" });
	});

	it("h8 a 128k model's status shows no declared window and the prefix stays stable", async () => {
		const t = await setup({ id: "m128k", contextWindow: 128_000, maxTokens: 16_000 }, {});
		harnesses.push(t.harness);
		await runPrompts(t.harness, t.model, { prompts: 2, turns: 30, min: 4_000, spread: 8_000 });
		const prefix = analyzePrefixes(t.model.requests, isNotice);
		report("h8", ENGINE_LABEL, "128k-status", {
			status: t.statuses.at(-1),
			cuts: t.stats.cuts.length,
			breaks: prefix.breaks,
		});
		expect(t.statuses.at(-1)).toMatch(/^ctx 128k · req \d+k\/84k · \d+ cuts · ratio \d\.\d\d$/);
		expect(prefix.breaks).toBe(t.stats.cuts.length);
	});
});
