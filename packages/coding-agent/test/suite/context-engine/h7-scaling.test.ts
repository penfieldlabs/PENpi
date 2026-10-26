/**
 * H7: per-request cost at 20,000 turns (opt-in: CONTEXT_ENGINE_SCALE=1). The session is built directly in the
 * session manager (20,000 assistant turns with tool results), then one prompt runs 30 tool turns.
 * Reports the engine's own handler time and the wall time per request (which includes Pi's own
 * O(history) work: projection rebuild and the structuredClone in emitContext).
 * Port (behaviours without a test, item 11): the bar is below 1 ms of engine time per request, with the
 * user-message pin on (the shipping default). Runs on request only (nightly on the VPS), as does bench.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { finalTurn, LOG_DIR, report, rng, scriptedModel, syntheticText, toolTurn, workExtension } from "./helpers.ts";

const TURNS = Number(process.env.CONTEXT_ENGINE_SCALE_TURNS ?? 20_000);

function buildSession(turns: number): SessionManager {
	const sm = SessionManager.inMemory(LOG_DIR);
	const next = rng(5);
	const now = Date.now() - turns * 10;
	for (let i = 0; i < turns; i++) {
		const t = now + i * 10;
		if (i % 20 === 0)
			sm.appendMessage({ role: "user", content: `Task ${i / 20}: process batch ${i / 20}.`, timestamp: t });
		if (i % 20 === 19) {
			sm.appendMessage(fauxAssistantMessage(`Done with batch ${Math.floor(i / 20)}.`, { timestamp: t + 1 }));
			continue;
		}
		const size = 300 + Math.floor(next() * 1_400);
		sm.appendMessage(
			fauxAssistantMessage([fauxText(`Step ${i}.`), fauxToolCall("work", { size, seed: i }, { id: `call-${i}` })], {
				stopReason: "toolUse",
				timestamp: t + 1,
			}),
		);
		sm.appendMessage({
			role: "toolResult",
			toolCallId: `call-${i}`,
			toolName: "work",
			content: [{ type: "text", text: syntheticText(size, i) }],
			isError: false,
			timestamp: t + 2,
		});
	}
	return sm;
}

describe.runIf(process.env.CONTEXT_ENGINE_SCALE === "1")("H7: per-request cost at scale", () => {
	it(`h7 ${TURNS} turns, mode a`, async () => {
		const built = performance.now();
		const sessionManager = buildSession(TURNS);
		const buildMs = performance.now() - built;
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			sessionManager,
			// The pin is on by default (PIN_DEFAULTS); the scale bar is measured with it.
			extensionFactories: [workExtension, createContextEngine({ mode: "a", stats })],
		});
		await harness.session.bindExtensions({});
		harness.session.refreshContext();
		const model = scriptedModel(harness);
		const times: number[] = [];
		let last = performance.now();
		for (let t = 0; t < 30; t++) {
			const step = toolTurn(1_000, 900_000 + t);
			model.push((context) => {
				const now = performance.now();
				times.push(now - last);
				last = now;
				return step(context);
			});
		}
		model.push(finalTurn("done"));
		last = performance.now();
		await harness.session.prompt("One more batch.");
		const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
		const steady = stats.handlerMs.slice(2);
		const result = {
			turns: TURNS,
			entries: sessionManager.getEntries().length,
			buildMs: Math.round(buildMs),
			firstHandlerMs: +stats.handlerMs[0].toFixed(1),
			handlerMsMedian: +median(steady).toFixed(2),
			handlerMsMax: +Math.max(...steady).toFixed(2),
			wallMsPerRequestMedian: Math.round(median(times.slice(2))),
			cuts: stats.cuts.length,
			maxPromptTokens: Math.max(...model.promptTokens),
			pinTokens: stats.pinTokens.at(-1),
		};
		report("h7", ENGINE_LABEL, `turns=${TURNS}`, result);
		harness.cleanup();
		expect(result.maxPromptTokens).toBeLessThanOrEqual(32_000);
		expect(stats.pinTokens.at(-1)).toBeGreaterThan(0);
		expect(result.handlerMsMedian).toBeLessThan(1);
	});
});
