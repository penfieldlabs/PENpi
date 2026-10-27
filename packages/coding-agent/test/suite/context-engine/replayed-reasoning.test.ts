/**
 * Port: replayedReasoning, a per-model setting ("provider/modelId" -> "counted" | "ignored"; default
 * "counted"). "counted" budgets the reasoning Pi replays; "ignored" leaves it out of the budget for that
 * model. The silent-truncation detector never counts replayed reasoning, so its appended estimate is the
 * same under both. Doctor names the setting when the ratio sits at the 0.8 floor with thinking on.
 */

import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, type EngineOptions, newStats, textTokens } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, workExtension } from "./helpers.ts";

const KEY = "faux/glm-200k";
const REASONING = "We count every event type in the file by hand, line by line, keeping a tally. ".repeat(200);
const TEXT = "The most common event type is order.shipped (412), then order.created (380). ".repeat(12);

describe("replayedReasoning: counted or ignored, per model", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Partial<EngineOptions>, contextWindow = 200_000) {
		const stats = newStats();
		const notices: string[] = [];
		const harness = await createHarness({
			models: [{ id: "glm-200k", contextWindow, maxTokens: 16_384, reasoning: true }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				workExtension,
				// The faux model stands for an OpenAI-compatible endpoint (GLM via OpenRouter), as in E2.
				createContextEngine({ stats, serializeAs: { [KEY]: "openai-completions" }, ...options }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify: (m) => notices.push(m) }) });
		return { stats, notices, harness, model: scriptedModel(harness, 200) };
	}

	/** One turn of about 3,000 reasoning tokens (replayed through the reasoning field) and 200 of text. */
	const thinkingTurn = (reasoning = REASONING): AssistantMessage => {
		const message = fauxAssistantMessage(TEXT);
		return {
			...message,
			content: [{ type: "thinking", thinking: reasoning, thinkingSignature: "reasoning" }, ...message.content],
		};
	};

	/** The doctor's replay-check line after `prompts` prompts, each answered with a thinking turn. */
	async function replayPairs(o: { reasoning?: string; prompt?: (i: number) => string; contextWindow?: number }) {
		const h = await setup({ replayedReasoning: { [KEY]: "ignored" } }, o.contextWindow);
		installProviderSim(h.harness, {});
		for (let i = 0; i < 12; i++) {
			h.model.push(() => thinkingTurn(o.reasoning));
			await h.harness.session.prompt(o.prompt?.(i) ?? `Count batch ${i}.`);
		}
		await h.harness.session.prompt("/penpi doctor");
		const line =
			h.notices
				.join("\n")
				.split("\n")
				.find((l) => l.startsWith("replay check:")) ?? "";
		return { line, pairs: Number(/replay check: (\d+) request pairs/.exec(line)?.[1] ?? 0), stats: h.stats };
	}

	it("replay check pairs: under 64 tokens of replayed reasoning, or under half the appended text, a pair does not count", async () => {
		const small = await replayPairs({ reasoning: "Tally them by hand. " });
		expect(textTokens("Tally them by hand. ")).toBeLessThan(64);
		expect(small.line).toBe("replay check: no request pairs with enough replayed reasoning yet");
		// About 3,000 tokens of reasoning, but each prompt appends about 8,000 tokens of text.
		const prompt = (i: number) => `Batch ${i}: ${"order.shipped order.created order.refunded ".repeat(1_100)}`;
		expect(textTokens(prompt(0))).toBeGreaterThan(2 * textTokens(REASONING));
		const large = await replayPairs({ prompt });
		expect(large.line).toBe("replay check: no request pairs with enough replayed reasoning yet");
		// The same reasoning with short prompts: 11 pairs.
		expect((await replayPairs({})).pairs).toBe(11);
	});

	it("replay check pairs: a cut request is not one of a consecutive pair (the prefix changed)", async () => {
		// 32k: each prompt adds about 3,300 tokens, so the window cuts a few times in 12 prompts.
		const { pairs, stats } = await replayPairs({ contextWindow: 32_000 });
		const cuts = stats.cuts.filter((c) => c.where === "request").length;
		expect(cuts).toBeGreaterThan(0);
		expect(pairs).toBe(11 - cuts);
	});

	async function budgetGrowth(setting: "counted" | "ignored" | undefined) {
		const h = await setup(setting ? { replayedReasoning: { [KEY]: setting } } : {});
		h.model.push(() => thinkingTurn(), finalTurn("ok"));
		await h.harness.session.prompt("Count the events.");
		await h.harness.session.prompt("Thanks.");
		const [first, second] = h.stats.sent;
		return { growth: second.estimate - first.estimate, appended: second.appended };
	}

	it("with ignored, a 3,000-token reasoning plus 200-token text turn adds only the text; with counted, both; the detector's appended estimate is the same", async () => {
		expect(textTokens(REASONING)).toBeGreaterThan(2_500);
		expect(textTokens(TEXT)).toBeGreaterThan(150);
		const counted = await budgetGrowth("counted");
		const byDefault = await budgetGrowth(undefined);
		const ignored = await budgetGrowth("ignored");
		// The turn plus the next prompt: the difference between the settings is the replayed reasoning.
		expect(counted.growth - ignored.growth).toBe(textTokens(REASONING));
		const prompt = 4 + textTokens("Thanks.");
		expect(ignored.growth).toBe(4 + textTokens(TEXT) + prompt);
		expect(counted.growth).toBe(4 + textTokens(REASONING) + textTokens(TEXT) + prompt);
		// "counted" is the default.
		expect(byDefault.growth).toBe(counted.growth);
		// The detector leaves replayed reasoning out under both.
		expect(counted.appended).toBe(ignored.appended);
		expect(counted.appended).toBe(ignored.growth);
	});

	/** 22 prompts, each answered with a thinking turn: 21 request pairs with no cut whose append replays it. */
	async function replayCheck(setting: "counted" | "ignored", providerIgnores: boolean) {
		const h = await setup(setting === "ignored" ? { replayedReasoning: { [KEY]: "ignored" } } : {});
		installProviderSim(h.harness, { ignoreReplayedReasoning: providerIgnores });
		for (let i = 0; i < 22; i++) {
			h.model.push(() => thinkingTurn());
			await h.harness.session.prompt(`Count batch ${i}.`);
		}
		expect(h.stats.cuts).toHaveLength(0);
		const warnings = h.notices.filter((n) => n.includes("the reasoning Pi replays"));
		await h.harness.session.prompt("/penpi doctor");
		const doctor =
			h.notices
				.join("\n")
				.split("\n")
				.find((l) => l.startsWith("replay check:")) ?? "";
		return { warnings, doctor, stats: h.stats };
	}

	it("replay check: warns once when ignored is set for a provider that counts, naming counted", async () => {
		const { warnings, doctor, stats } = await replayCheck("ignored", false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`${KEY} counts the reasoning Pi replays`);
		expect(warnings[0]).toContain(`but replayedReasoning is "ignored", so the budget under-counts every request`);
		expect(warnings[0]).toContain(`Try replayedReasoning { "${KEY}": "counted" }`);
		expect(stats.replayWarnings).toEqual([
			expect.objectContaining({ key: KEY, setting: "ignored", observed: "counted" }),
		]);
		expect(stats.replayWarnings[0].median).toBeGreaterThan(0.8);
		expect(stats.replayWarnings[0].pairs).toBe(20);
		expect(doctor).toMatch(
			/replay check: 21 request pairs, median share [\d.]+ .*\(the provider counts it\); disagrees with the setting \(warned\)/,
		);
	});

	it("replay check: warns once when counted (the default) meets a provider that ignores it, naming ignored", async () => {
		const { warnings, doctor, stats } = await replayCheck("counted", true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`${KEY} ignores the reasoning Pi replays`);
		expect(warnings[0]).toContain(`Try replayedReasoning { "${KEY}": "ignored" }`);
		expect(stats.replayWarnings[0].median).toBeLessThan(0.2);
		expect(doctor).toContain("(the provider ignores it); disagrees with the setting (warned)");
	});

	it("N1: the replay check is silent without a verdict (a provider counting 40% of the replay)", async () => {
		for (const setting of ["counted", "ignored"] as const) {
			const h = await setup(setting === "ignored" ? { replayedReasoning: { [KEY]: "ignored" } } : {});
			installProviderSim(h.harness, { replayedReasoningShare: 0.4 });
			for (let i = 0; i < 22; i++) {
				h.model.push(() => thinkingTurn());
				await h.harness.session.prompt(`Count batch ${i}.`);
			}
			await h.harness.session.prompt("/penpi doctor");
			expect(
				h.notices.filter((n) => n.includes("the reasoning Pi replays")),
				setting,
			).toEqual([]);
			expect(h.stats.replayWarnings).toEqual([]);
			const line =
				h.notices
					.join("\n")
					.split("\n")
					.find((l) => l.startsWith("replay check:")) ?? "";
			expect(line).toMatch(/median share 0\.[34]\d .*no verdict.*; no recommendation/);
		}
	});

	it("N1 (round 4): with ignored set, a provider that counts the replay in 2 of every 5 pairs gets one warning recommending counted", async () => {
		// Shares of 0.02 and 0.97: no verdict (the 0.97s withhold "ignored"), but "ignored" under-counts those.
		const mixed = (assistant: number) => (assistant % 5 === 1 || assistant % 5 === 3 ? 0.97 : 0.02);
		for (const setting of ["ignored", "counted"] as const) {
			const h = await setup(setting === "ignored" ? { replayedReasoning: { [KEY]: "ignored" } } : {}, 1_000_000);
			installProviderSim(h.harness, { replayedReasoningShare: mixed });
			for (let i = 0; i < 27; i++) {
				h.model.push(() => thinkingTurn());
				await h.harness.session.prompt(`Count batch ${i}.`);
			}
			await h.harness.session.prompt("/penpi doctor");
			const warnings = h.notices.filter((n) => n.includes("the reasoning Pi replays"));
			const line =
				h.notices
					.join("\n")
					.split("\n")
					.find((l) => l.startsWith("replay check:")) ?? "";
			if (setting === "counted") {
				expect(warnings, setting).toEqual([]);
				expect(h.stats.replayWarnings).toEqual([]);
				expect(line).toMatch(/no verdict.*; no recommendation/);
				continue;
			}
			expect(warnings, line).toHaveLength(1);
			// The silent check passes over a few low pairs (a shortfall after a counted one), so the first 20 that
			// qualify hold 8 or 9 that count the replay; the unit test has the exact 12 x 0.02 with 8 x 0.97.
			expect(warnings[0]).toMatch(
				new RegExp(`${KEY} counts the reasoning Pi replays in [89] of 20 request pairs with no cut`),
			);
			expect(warnings[0]).toContain(`but replayedReasoning is "ignored", so the budget under-counts those requests`);
			expect(warnings[0]).toContain(`Try replayedReasoning { "${KEY}": "counted" } (the default: remove the entry)`);
			expect(h.stats.replayWarnings).toEqual([
				expect.objectContaining({ key: KEY, setting: "ignored", observed: "counted", pairs: 20 }),
			]);
			expect(h.stats.replayWarnings[0].median).toBeLessThan(0.1);
			expect(line).toMatch(
				/no verdict.*; some pairs count it and the setting is "ignored": recommends "counted" \(warned\)/,
			);
		}
	});

	it("replay check: no warning when the setting matches the provider, either way", async () => {
		for (const [setting, ignores] of [
			["counted", false],
			["ignored", true],
		] as const) {
			const { warnings, doctor, stats } = await replayCheck(setting, ignores);
			expect(warnings, `${setting}, provider ${ignores ? "ignores" : "counts"}`).toEqual([]);
			expect(stats.replayWarnings).toEqual([]);
			expect(doctor).toContain("agrees with the setting");
		}
	});

	it("doctor names replayedReasoning when the ratio sits at the 0.8 floor with thinking on", async () => {
		const h = await setup({});
		// The provider reports 70% of the estimate (it does not count the replayed reasoning): the ratio clamps
		// at the 0.8 floor.
		installProviderSim(h.harness, { scale: 0.7 });
		h.harness.session.setThinkingLevel("high");
		for (let i = 0; i < 8; i++) {
			h.model.push(() => thinkingTurn());
			await h.harness.session.prompt(`Count batch ${i}.`);
		}
		await h.harness.session.prompt("/penpi doctor");
		const doctor = h.notices.join("\n");
		expect(doctor).toContain(`replayed reasoning: counted for ${KEY}`);
		expect(doctor).toContain(`set replayedReasoning { "${KEY}": "ignored" }`);
		// Set to ignored, doctor reports it and gives no hint.
		const set = await setup({ replayedReasoning: { [KEY]: "ignored" } });
		await set.harness.session.prompt("/penpi doctor");
		expect(set.notices.join("\n")).toContain(`replayed reasoning: ignored (left out of the budget) for ${KEY}`);
	});
});
