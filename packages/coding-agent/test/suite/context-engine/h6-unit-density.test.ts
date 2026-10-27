/**
 * H6: no unit too large in real tokens. A capped CJK or base64 tool result must stay within the unit
 * share of the budget when counted by a real tokenizer (o200k_base), and images are capped and
 * recallable.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, NOTICE_MARKER, newStats } from "./engine.ts";
import {
	analyzePrefixes,
	anthropicImageTokens,
	blobExtension,
	finalTurn,
	installProviderSim,
	logger,
	report,
	scriptedModel,
	toolTurn,
	validateRequest,
	workExtension,
} from "./helpers.ts";
import { o200kTokens } from "./tokenizers.ts";

const WINDOW = 32_000;
const BUDGET = WINDOW - 4_000;
const UNIT_SHARE = 0.25;
const zh = readFileSync(new URL("./samples/zh.txt", import.meta.url), "utf8");
const cjk = zh.repeat(Math.ceil(40_000 / zh.length)).slice(0, 40_000);
const base64 = randomBytes(60_000).toString("base64");
const screenshot = readFileSync(new URL("../../../docs/images/doom-extension.png", import.meta.url)).toString("base64");

function blobResultText(request: string[]): string {
	const result = request.map((m) => JSON.parse(m)).find((m) => m.role === "toolResult" && m.toolName === "blob");
	return result
		? (result.content as Array<{ type: string; text?: string }>)
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("")
		: "";
}

describe("H6: unit caps in real tokens, and images", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const [kind, text] of [
		["cjk", cjk],
		["base64", base64],
	] as const) {
		for (const mode of ["a"] as const) {
			it(`h6 ${kind} unit stays within its share of the budget in o200k tokens (mode ${mode})`, async () => {
				const stats = newStats();
				const harness = await createHarness({
					models: [{ id: "faux-32k", contextWindow: WINDOW, maxTokens: 4_000 }],
					settings: { compaction: { enabled: false } },
					extensionFactories: [blobExtension({ big: { text } }), createContextEngine({ mode, stats })],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				const model = scriptedModel(harness);
				model.push(
					() => fauxAssistantMessage([fauxToolCall("blob", { name: "big" })], { stopReason: "toolUse" }),
					finalTurn("ok"),
				);
				await harness.session.prompt(`Load the ${kind} blob.`);
				const shown = blobResultText(model.requests[1] ?? []);
				const realTokens = o200kTokens(shown);
				report("h6", ENGINE_LABEL, `${kind}.${mode}`, {
					originalChars: text.length,
					originalO200k: o200kTokens(text),
					shownChars: shown.length,
					shownO200k: realTokens,
					shareOfBudget: +(realTokens / BUDGET).toFixed(3),
				});
				expect(shown.length).toBeLessThan(text.length);
				expect(realTokens).toBeLessThanOrEqual(UNIT_SHARE * BUDGET * 1.15);
			});
		}
	}

	for (const mode of ["a"] as const) {
		it(`h6 a tool result with 20 large screenshots fits and the images stay recallable (mode ${mode})`, async () => {
			const stats = newStats();
			const images = Array.from({ length: 20 }, () => ({ data: screenshot, mimeType: "image/png" }));
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: WINDOW, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false }, images: { autoResize: false } },
				extensionFactories: [
					blobExtension({ shots: { text: "20 screenshots", images } }),
					createContextEngine({ mode, stats, log: logger(`h6.${ENGINE_LABEL}.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, { realLimit: WINDOW, imageTokens: anthropicImageTokens });
			const model = scriptedModel(harness);
			let recalled: unknown;
			model.push(
				() => fauxAssistantMessage([fauxToolCall("blob", { name: "shots" })], { stopReason: "toolUse" }),
				(context: TranscriptContext) => {
					const text = JSON.stringify(context.messages.at(-1) ?? "");
					const match = text.match(/context_recall\(\{ \\"entry\\": \\"([^\\]+)\\", \\"image\\": (\d+) \}\)/);
					recalled = match ? { entry: match[1], image: Number(match[2]) } : undefined;
					return recalled
						? fauxAssistantMessage([fauxToolCall("context_recall", recalled as never)], {
								stopReason: "toolUse",
							})
						: fauxAssistantMessage("no placeholder found");
				},
				finalTurn("seen"),
			);
			await harness.session.prompt("Take the screenshots.");
			const last = harness.session.messages.filter((m) => m.role === "assistant").at(-1);
			const recallResult = harness.sessionManager
				.getEntries()
				.find(
					(e) =>
						e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "context_recall",
				);
			const recallImages =
				recallResult?.type === "message"
					? (recallResult.message as unknown as { content: Array<{ type: string }> }).content.filter(
							(b) => b.type === "image",
						).length
					: 0;
			report("h6", ENGINE_LABEL, `images.${mode}`, {
				imageTokensEach: anthropicImageTokens({ data: screenshot }),
				calls: sim.calls.map((c) => ({ promptTokens: c.promptTokens, rejected: c.rejected })),
				lastStop: last?.role === "assistant" ? last.stopReason : undefined,
				recalled,
				recallImages,
			});
			expect(sim.calls.filter((c) => c.rejected)).toHaveLength(0);
			expect(last?.role === "assistant" && last.stopReason).toBe("stop");
			expect(recallImages).toBe(1);
		});

		it(`h6 screenshots across a session stay within the window, prefix-stable (mode ${mode})`, async () => {
			const stats = newStats();
			const images = Array.from({ length: 3 }, () => ({ data: screenshot, mimeType: "image/png" }));
			const harness = await createHarness({
				models: [{ id: "faux-32k", contextWindow: WINDOW, maxTokens: 4_000 }],
				settings: { compaction: { enabled: false }, images: { autoResize: false } },
				extensionFactories: [
					workExtension,
					blobExtension({ shots: { text: "3 screenshots", images } }),
					createContextEngine({ mode, stats }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, { realLimit: WINDOW, imageTokens: anthropicImageTokens });
			const model = scriptedModel(harness);
			for (let p = 0; p < 4; p++) {
				for (let t = 0; t < 12; t++) {
					model.push(
						t % 3 === 0
							? () => fauxAssistantMessage([fauxToolCall("blob", { name: "shots" })], { stopReason: "toolUse" })
							: toolTurn(1_500, p * 100 + t),
					);
				}
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`Visual task ${p}`);
			}
			const prefix = analyzePrefixes(
				model.requests,
				(m) => NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER),
			);
			report("h6", ENGINE_LABEL, `image-session.${mode}`, {
				calls: sim.calls.length,
				rejected: sim.calls.filter((c) => c.rejected).length,
				maxPromptTokens: Math.max(...sim.calls.map((c) => c.promptTokens)),
				cuts: stats.cuts.length,
				prefixBreaks: prefix.breaks,
				violations: model.requests.flatMap((r) => validateRequest(r)).length,
			});
			expect(sim.calls.filter((c) => c.rejected)).toHaveLength(0);
			expect(model.cursor).toBe(52);
			// Image placeholders are decided at cuts and frozen, so the prefix still changes only at cuts.
			expect(prefix.breaks).toBeLessThanOrEqual(stats.cuts.length);
		});
	}
});
