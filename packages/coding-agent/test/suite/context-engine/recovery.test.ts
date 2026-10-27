/**
 * E5 overflow recovery without summarization, E7 wrong / missing window metadata, and E1 with the
 * compaction setting left on.
 */
import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	LOG_DIR,
	logger,
	rng,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

const results: Record<string, unknown> = {};

describe("context engine: overflow recovery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		writeFileSync(`${LOG_DIR}/recovery.json`, JSON.stringify(results, null, 2));
	});

	for (const mode of ["a"] as const) {
		for (const [compactionEnabled, injectAt] of [
			[false, 0],
			[true, 0],
			[false, 12],
			[true, 12],
			[false, 60],
			[true, 60],
		] as const) {
			it(`mode ${mode}, compaction.enabled=${compactionEnabled}: injected overflow at provider call ${injectAt} is retried once`, async () => {
				const stats = newStats();
				const harness = await createHarness({
					models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
					settings: { compaction: { enabled: compactionEnabled } },
					extensionFactories: [
						workExtension,
						// These cases document Pi's own paths with the setting on, so the P5 refusal is relaxed to a warning.
						createContextEngine({
							mode,
							stats,
							onCompactionEnabled: "warn",
							log: logger(`recovery.${mode}.log`),
						}),
					],
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				const model = scriptedModel(harness);
				// Inject one overflow error the engine cannot parse a limit from.
				let calls = 0;
				const original = harness.session.agent.streamFunction;
				harness.session.agent.streamFunction = async (m, context, options) => {
					if (calls++ === injectAt) {
						const stream = createAssistantMessageEventStream();
						const error = fauxAssistantMessage([], {
							stopReason: "error",
							errorMessage: "Your input exceeds the context window of this model",
						});
						Object.assign(error, { provider: m.provider, model: m.id, api: m.api });
						queueMicrotask(() => {
							stream.push({ type: "error", reason: "error", error });
							stream.end(error);
						});
						return stream;
					}
					return original(m, context, options);
				};
				const turns = injectAt === 0 ? 1 : injectAt + 3;
				for (let t = 0; t < turns; t++) model.push(toolTurn(2_000, t));
				model.push(finalTurn("answer after retry"));
				await harness.session.prompt("Do the thing.");

				const messages = harness.session.messages;
				const finalText = messages.filter((m) => m.role === "assistant").at(-1);
				const requestsWithError = model.requests.filter((r) =>
					r.some((m) => m.includes("exceeds the context window")),
				);
				const rawErrors = harness.sessionManager
					.getEntries()
					.filter(
						(e) => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "error",
					);
				results[`injected@${injectAt}.${mode}.enabled=${compactionEnabled}`] = {
					overflowRetries: stats.overflowRetries,
					compactionStart: harness.eventsOfType("compaction_start").map((e) => e.reason),
					compactionEnd: harness
						.eventsOfType("compaction_end")
						.map((e) => ({ aborted: e.aborted, willRetry: e.willRetry, error: e.errorMessage })),
					cancelledByEngine: stats.cancelledCompactions,
					modelRequests: model.requests.length,
					errorsInLaterRequests: requestsWithError.length,
					rawErrorEntriesKept: rawErrors.length,
					contextEdits: harness.sessionManager.getEntries().filter((e) => e.type === "context_edit").length,
					usageAfter: harness.session.getContextUsage(),
				};
				expect(stats.overflowRetries).toBe(1);
				expect(finalText?.role === "assistant" && finalText.stopReason).toBe("stop");
				expect(requestsWithError).toHaveLength(0);
				expect(rawErrors).toHaveLength(1); // the failed attempt stays in the transcript
				expect(model.requests).toHaveLength(turns + 1);
				expect(harness.faux.state.callCount).toBe(turns + 1);
				if (!compactionEnabled) expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
			});
		}

		it(`mode ${mode}: wrong (too large) window metadata, provider rejects above a smaller real limit`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-wrong", contextWindow: 200_000, maxTokens: 8_000 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, log: logger(`recovery.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, { realLimit: 20_000 });
			const model = scriptedModel(harness);
			const next = rng(3);
			let seed = 0;
			for (let p = 0; p < 4; p++) {
				for (let t = 0; t < 19; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), seed++));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`Task ${p}`);
			}
			const rejected = sim.calls.filter((c) => c.rejected);
			const firstRejection = sim.calls.findIndex((c) => c.rejected);
			const afterLearning = sim.calls.slice(firstRejection + 1);
			results[`wrong-window.${mode}`] = {
				calls: sim.calls.length,
				rejected: rejected.length,
				firstRejection,
				maxAfterLearning: Math.max(...afterLearning.map((c) => c.promptTokens)),
				overflowRetries: stats.overflowRetries,
				cuts: stats.cuts.length,
				assistantTurns: model.cursor,
				compactionStart: harness.eventsOfType("compaction_start").length,
			};
			expect(model.cursor).toBe(80); // every scripted turn ran: no turn failed
			expect(rejected.length).toBe(1);
			expect(Math.max(...afterLearning.map((c) => c.promptTokens))).toBeLessThanOrEqual(20_000);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		});

		it(`mode ${mode}: model with no context window uses the conservative default`, async () => {
			const stats = newStats();
			const harness = await createHarness({
				models: [{ id: "faux-nowindow", contextWindow: 0, maxTokens: 0 }],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					workExtension,
					createContextEngine({ mode, stats, defaultWindow: 24_000, log: logger(`recovery.${mode}.log`) }),
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const sim = installProviderSim(harness, { realLimit: 30_000 });
			const model = scriptedModel(harness);
			const next = rng(5);
			let seed = 0;
			for (let p = 0; p < 3; p++) {
				for (let t = 0; t < 19; t++) model.push(toolTurn(1_000 + Math.floor(next() * 4_000), seed++));
				model.push(finalTurn(`done ${p}`));
				await harness.session.prompt(`Task ${p}`);
			}
			results[`no-window.${mode}`] = {
				usage: harness.session.getContextUsage() ?? "undefined (Pi has no window)",
				maxPrompt: Math.max(...sim.calls.map((c) => c.promptTokens)),
				maxTokensSent: [...new Set(sim.calls.map((c) => c.maxTokens))],
				rejected: sim.calls.filter((c) => c.rejected).length,
				cuts: stats.cuts.length,
				clampedOutput: stats.clampedOutput,
			};
			expect(model.cursor).toBe(60);
			expect(sim.calls.filter((c) => c.rejected)).toHaveLength(0);
			expect(Math.max(...sim.calls.map((c) => c.promptTokens))).toBeLessThanOrEqual(24_000);
			expect(stats.cuts.length).toBeGreaterThan(0);
		});
	}
});
