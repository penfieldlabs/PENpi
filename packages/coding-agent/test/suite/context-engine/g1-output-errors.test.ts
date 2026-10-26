/**
 * G1: output-limit errors (and combined input + output errors whose input alone fits) are classified
 * before Pi's isContextOverflow is consulted; they teach the output ceiling or the output room and
 * are retried, bounded, and they never shrink the window. Every fixture in g1-error-fixtures.ts is
 * classified; every fixture with a renderable wording also runs end to end.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { classifyProviderError, createContextEngine, ENGINE_LABEL, newStats } from "./engine.ts";
import { ERROR_FIXTURES, type ErrorFixture } from "./g1-error-fixtures.ts";
import { finalTurn, installProviderSim, logger, report, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const MODEL = { id: "g1-model", contextWindow: 200_000, maxTokens: 943_717 };

function piSaysOverflow(text: string): boolean {
	return isContextOverflow({
		role: "assistant",
		stopReason: "error",
		errorMessage: text,
		content: [],
	} as unknown as AssistantMessage);
}

type Reject = NonNullable<NonNullable<Parameters<typeof installProviderSim>[1]>["reject"]>;

async function setup(reject: Reject, label: string) {
	const stats = newStats();
	const harness = await createHarness({
		models: [MODEL],
		// Pi's own transient-error retry stays on (as in production) with a short delay.
		settings: { compaction: { enabled: false }, retry: { baseDelayMs: 1, maxRetries: 2 } },
		extensionFactories: [
			workExtension,
			createContextEngine({ stats, log: logger(`g1.${ENGINE_LABEL}.${label}.log`) }),
		],
	});
	await harness.session.bindExtensions({});
	const sim = installProviderSim(harness, { reject });
	const model = scriptedModel(harness);
	return { stats, harness, sim, model };
}

function lastAssistant(harness: Harness): AssistantMessage | undefined {
	const entry = [...harness.sessionManager.getBranch()]
		.reverse()
		.find((e) => e.type === "message" && e.message.role === "assistant");
	return entry?.type === "message" ? (entry.message as AssistantMessage) : undefined;
}

describe("G1: provider error classes", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const table: Array<Record<string, unknown>> = [];
	for (const fixture of ERROR_FIXTURES) {
		it(`g1 classify ${fixture.id} (${fixture.provider}) as ${fixture.expected.class}`, () => {
			const info = classifyProviderError(fixture.text);
			table.push({
				id: fixture.id,
				provider: fixture.provider,
				expected: fixture.expected.class,
				got: info.class,
				rule: info.rule,
				outputLimit: info.outputLimit,
				input: info.input,
				contextLimit: info.contextLimit,
				piIsContextOverflow: piSaysOverflow(fixture.text),
				verified: fixture.verified,
			});
			report("g1", ENGINE_LABEL, "classification", table);
			expect(info.class).toBe(fixture.expected.class);
			for (const key of ["outputLimit", "input", "contextLimit"] as const) {
				if (fixture.expected[key] !== undefined) expect(info[key]).toBe(fixture.expected[key]);
			}
		});
	}

	const outputFixtures = ERROR_FIXTURES.filter((f) => f.render && f.expected.class === "output-limit");
	for (const fixture of outputFixtures) {
		const stated = fixture.expected.outputLimit !== undefined;
		it(`g1 e2e ${fixture.id}: ceiling ${stated ? "learned from the message" : "stepped down"}, retried, window unchanged`, async () => {
			// The model claims 943,717 output tokens (implausible): the engine asks for 16,384 at first (the
			// round-1 baseline asks for 4,096). The real limit is 2,000 when the message states it, 3,000 when
			// it does not (16,384 -> 8,192 -> 4,096 -> 2,048). A wording copied verbatim carries its own limit.
			const at = (limit: number) =>
				fixture.render!({ requested: 99_999, limit, input: 0, context: 0, model: MODEL.id });
			const fixedLimit = at(1) === at(2) ? /at most (\d+) completion/.exec(at(1))?.[1] : undefined;
			const realOutput = fixedLimit ? Number(fixedLimit) : stated ? 2_000 : 3_000;
			const t = await setup(
				({ maxTokens, promptTokens }) =>
					(maxTokens ?? Number.POSITIVE_INFINITY) > realOutput
						? fixture.render!({
								requested: maxTokens ?? 0,
								limit: realOutput,
								input: promptTokens,
								context: MODEL.contextWindow,
								model: MODEL.id,
							})
						: undefined,
				fixture.id,
			);
			harnesses.push(t.harness);
			t.model.push(toolTurn(2_000, 1), toolTurn(2_000, 2), toolTurn(2_000, 3), finalTurn("done"));
			await t.harness.session.prompt("Do the work.");
			const rejected = t.sim.calls.filter((c) => c.rejected).length;
			const expectedCeiling = stated ? realOutput : 2_048;
			report("g1", ENGINE_LABEL, `e2e.${fixture.id}`, {
				rejected,
				maxTokensSent: t.sim.calls.map((c) => c.maxTokens),
				providerErrors: t.stats.providerErrors,
				engineRetries: t.stats.outputRetries,
				window: t.stats.lastLimits?.window,
				maxOutput: t.stats.lastLimits?.maxOutput,
				learnedWindows: t.stats.learnedWindows?.length,
			});
			// Behaviour first: the run completes after a bounded number of rejections.
			expect(lastAssistant(t.harness)?.stopReason).toBe("stop");
			expect(t.model.cursor).toBe(4);
			expect(rejected).toBe(stated ? 1 : 3);
			// The window is untouched; the output ceiling is learned.
			expect(t.stats.learnedWindows ?? []).toHaveLength(0);
			expect(t.stats.lastLimits?.window).toBe(200_000);
			expect(t.stats.lastLimits?.maxOutput).toBe(expectedCeiling);
			expect(t.stats.providerErrors?.length).toBeGreaterThan(0);
			expect(t.stats.providerErrors?.every((e) => e.class === "output-limit")).toBe(true);
		});
	}

	it("g1 e2e no number and no output the provider accepts: bounded, then the error surfaces", async () => {
		const fixture = ERROR_FIXTURES.find((f) => f.id === "scaleway-output") as ErrorFixture;
		const t = await setup(
			({ maxTokens }) =>
				(maxTokens ?? Number.POSITIVE_INFINITY) > 500
					? fixture.render!({ requested: 0, limit: 0, input: 0, context: 0, model: MODEL.id })
					: undefined,
			"bounded",
		);
		harnesses.push(t.harness);
		t.model.push(finalTurn("never reached"));
		await t.harness.session.prompt("Answer.");
		const rejected = t.sim.calls.filter((c) => c.rejected).length;
		report("g1", ENGINE_LABEL, "e2e.bounded", {
			rejected,
			maxTokensSent: t.sim.calls.map((c) => c.maxTokens),
			engineRetries: t.stats.outputRetries,
		});
		// 16,384 -> 8,192 -> 4,096 -> 2,048: three retries, then the error is shown; the window is untouched.
		expect(lastAssistant(t.harness)?.stopReason).toBe("error");
		expect(rejected).toBe(4);
		expect(t.stats.outputRetries).toBe(3);
		expect(t.stats.learnedWindows ?? []).toHaveLength(0);
		expect(t.stats.lastLimits?.window).toBe(200_000);
	});

	const combinedFixtures = ERROR_FIXTURES.filter((f) => f.render && f.expected.class === "combined-output-caused");
	for (const fixture of combinedFixtures) {
		it(`g1 e2e ${fixture.id}: output room learned, retried, window unchanged`, async () => {
			// The provider's real context is 30,500; the second request carries about 26,700 input tokens
			// and asks for 16,384 output tokens (the round-1 baseline: 4,096): input + output > context,
			// the input alone fits with about 3,800 tokens to spare.
			const context = 30_500;
			const t = await setup(
				({ maxTokens, promptTokens }) =>
					promptTokens + (maxTokens ?? 0) > context
						? fixture.render!({
								requested: maxTokens ?? 0,
								limit: 0,
								input: promptTokens,
								context,
								model: MODEL.id,
							})
						: undefined,
				fixture.id,
			);
			harnesses.push(t.harness);
			t.model.push(toolTurn(100_000, 1), finalTurn("done"));
			await t.harness.session.prompt("Read the big file.");
			const rejectedCalls = t.sim.calls.filter((c) => c.rejected);
			const retry = t.sim.calls[t.sim.calls.indexOf(rejectedCalls[0]) + 1];
			report("g1", ENGINE_LABEL, `e2e.${fixture.id}`, {
				rejected: rejectedCalls.length,
				rejectedInput: rejectedCalls[0]?.promptTokens,
				rejectedMaxTokens: rejectedCalls[0]?.maxTokens,
				retryInput: retry?.promptTokens,
				retryMaxTokens: retry?.maxTokens,
				providerErrors: t.stats.providerErrors,
				window: t.stats.lastLimits?.window,
				learnedWindows: t.stats.learnedWindows?.length,
			});
			// Behaviour first: one rejection, then a retry that fits and completes the run.
			expect(lastAssistant(t.harness)?.stopReason).toBe("stop");
			expect(t.model.cursor).toBe(2);
			expect(rejectedCalls).toHaveLength(1);
			expect(retry.promptTokens).toBe(rejectedCalls[0].promptTokens);
			expect(retry.promptTokens + (retry.maxTokens ?? 0)).toBeLessThanOrEqual(context);
			expect(retry.maxTokens).toBeGreaterThan(1_024);
			// The window is untouched.
			expect(t.stats.learnedWindows ?? []).toHaveLength(0);
			expect(t.stats.lastLimits?.window).toBe(200_000);
			expect(t.stats.providerErrors?.[0]?.class).toBe("combined-output-caused");
		});
	}
});
