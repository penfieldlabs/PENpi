/**
 * Properties of every request the engine sends, over seeded random sessions (deterministic: a failure
 * reproduces from its window and seed) for windows from 8k to 1M tokens:
 *
 *   fit       an honest provider (rejects above the declared window) never rejects a request, and every
 *             request leaves room for the output it asks for (prompt + max_tokens <= window);
 *   validity  every request starts with a user message and pairs every tool call with its result;
 *   prefix    between two cuts each request extends the previous one (the provider's prompt cache holds):
 *             the requests break their prefix exactly once per cut;
 *   header    the header stays within its planned bound, and the pinned user messages within their cap,
 *             min(10% of the planning window, 20,000), compared with the calibrated estimate (D9).
 *
 * Sessions mix tool outputs of log-uniform size (some above the per-unit cap) and ten user prompts (every third
 * one longer than the pin cap, the others carried whole, so small windows fill the pin to its cap), against a provider that counts 0.9 to 1.6 times the estimate.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	analyzePrefixes,
	finalTurn,
	installProviderSim,
	rng,
	scriptedModel,
	syntheticText,
	validateRequest,
	workExtension,
} from "./helpers.ts";

const WINDOWS = [8_192, 32_768, 131_072, 200_000, 1_048_576];
const SEEDS = [1, 2, 3];
const CEILING = 200_000;

describe("properties of every request, over random sessions", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const window of WINDOWS)
		for (const seed of SEEDS)
			it(`window ${window}, seed ${seed}: fit, validity, prefix and header`, async () => {
				const r = rng(window + seed * 7_919);
				const maxTokens = Math.min(16_384, Math.floor(window / 8));
				const scale = 0.9 + 0.7 * r();
				const stats = newStats();
				const harness = await createHarness({
					models: [{ id: `prop-${window}`, contextWindow: window, maxTokens }],
					settings: { compaction: { enabled: false } },
					extensionFactories: [workExtension, createContextEngine({ stats })],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				const sim = installProviderSim(harness, { scale, realLimit: window });
				const model = scriptedModel(harness, 2_000);
				const planning = Math.min(window, CEILING);
				// Tool outputs from 200 characters to 40% of the planning window (in characters, ~4 per token).
				const toolChars = () => Math.round(200 * (planning * 1.6) ** (r() ** 1.3));
				let step = 0;
				for (let p = 0; p < 10; p++) {
					const turns = 3 + Math.floor(r() * 5);
					for (let t = 0; t < turns; t++) {
						const n = step++;
						const size = Math.min(toolChars(), planning * 1.6);
						model.push(() =>
							fauxAssistantMessage(
								[fauxText(`Step ${n}.`), fauxToolCall("work", { size, seed: n }, { id: `call-${n}` })],
								{ stopReason: "toolUse" },
							),
						);
					}
					model.push(finalTurn(`Done with task ${p}.`));
					// Every third prompt is long, 12-20% of the planning window (over the pin cap, under the per-unit
					// cap); the pin carries it as an excerpt. The others are 1,200-1,900 characters, under the pin's
					// long-message threshold, so they are carried whole and fill the pin toward its cap.
					const promptChars =
						p % 3 === 2 ? Math.round((0.12 + 0.08 * r()) * planning * 4) : Math.round(1_200 + 700 * r());
					await harness.session.prompt(`Task ${p}: ${syntheticText(promptChars, 1_000 + p).replace(/\s+/g, " ")}`);
				}

				const label = `window ${window} seed ${seed} (scale ${scale.toFixed(2)})`;
				expect(model.requests.length, label).toBeGreaterThan(20);
				// fit
				expect(
					sim.calls.filter((c) => c.rejected),
					`${label}: rejected`,
				).toHaveLength(0);
				for (const [i, call] of sim.calls.entries())
					expect(call.promptTokens + (call.maxTokens ?? 0), `${label}: request ${i + 1} fits`).toBeLessThanOrEqual(
						window,
					);
				// validity
				for (const [i, request] of model.requests.entries())
					expect(validateRequest(request), `${label}: request ${i + 1}`).toEqual([]);
				// prefix
				expect(analyzePrefixes(model.requests).breaks, `${label}: prefix breaks`).toBe(stats.cuts.length);
				// header
				expect(stats.headerBoundMisses, `${label}: header bound`).toBe(0);
				const cap = Math.min(Math.floor(0.1 * planning), 20_000);
				for (const [i, tokens] of stats.pinTokens.entries())
					expect(tokens * (stats.sent[i]?.ratio ?? 1), `${label}: pin of request ${i + 1}`).toBeLessThanOrEqual(
						cap + 1,
					);
				// The sweep exercises what it claims: cuts in every run, and where ten prompts can fill it (windows
				// up to 32k), a pin near its cap.
				expect(stats.cuts.length, `${label}: cuts`).toBeGreaterThan(2);
				const pinMax = Math.max(0, ...stats.pinTokens.map((t, i) => t * (stats.sent[i]?.ratio ?? 1)));
				if (planning <= 32_768) expect(pinMax, `${label}: pin near its cap`).toBeGreaterThan(0.8 * cap);
			});
});
