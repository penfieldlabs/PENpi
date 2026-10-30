/**
 * 0.6.0 (Pi 1.4): an HTTP 413 request-size error with no token numbers is not a context window to learn. Pi 1.4's
 * isContextOverflow matches it; the engine leaves it to Pi, as 0.5.x did: no window is learned and the engine does
 * not retry it as an overflow. A 413 that names a token overflow (Vertex for Anthropic) still recovers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const MODEL = { id: "v060-413", contextWindow: 200_000, maxTokens: 16_384 };

describe("0.6.0: a 413 without token numbers", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(errorText: string) {
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false }, retry: { baseDelayMs: 1, maxRetries: 0 } },
			extensionFactories: [workExtension, createContextEngine({ stats, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// The second request (after one tool turn, well inside the window) is rejected once.
		const sim = installProviderSim(harness, { reject: ({ index }) => (index === 1 ? errorText : undefined) });
		const model = scriptedModel(harness);
		model.push(toolTurn(2_000, 1), finalTurn("done"), finalTurn("done"));
		await harness.session.prompt("Do the work.");
		return { stats, lines, sim };
	}

	it("v060 Anthropic request_too_large (413): no window learned, no overflow retry", async () => {
		const t = await run('413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}');
		expect(t.sim.calls.filter((c) => c.rejected)).toHaveLength(1);
		expect(t.stats.overflowRetries).toBe(0);
		expect(t.stats.lastLimits?.window).toBe(MODEL.contextWindow);
		expect(t.lines.filter((l) => /learned window|window learned|shrunk|overflow retry/i.test(l))).toEqual([]);
	});

	it("v060 a 413 that says the prompt is too long still recovers as an overflow", async () => {
		const t = await run(
			'API Error: 413 {"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Prompt is too long\\"}}","type":"None","param":"None","code":"413"}',
		);
		expect(t.sim.calls.filter((c) => c.rejected)).toHaveLength(1);
		expect(t.stats.overflowRetries).toBe(1);
	});
});
