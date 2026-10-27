/**
 * D1: fault injection. One switch (the `faults` option or PENPI_FAULTS) turns successful responses
 * into context-overflow errors, output-limit errors or length stops, on a schedule or with a
 * probability. Off by default; loud at startup and on every fault; shown in the status line and
 * /penpi doctor; refused when PENPI_PRODUCTION=1 or the `production` option marks the deployment as
 * production. Not a setting: penpi.faults and penpi.production are ignored (engine/settings.ts).
 */
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import {
	createContextEngine,
	ENGINE_LABEL,
	type EngineOptions,
	FAULTS_ENV,
	newStats,
	PRODUCTION_ENV,
	parseFaultSpec,
} from "./engine.ts";
import { installProviderSim, report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

async function setup(engine: Partial<EngineOptions>, settings: Record<string, unknown> = {}) {
	const stats = newStats();
	const notices: Array<{ message: string; type?: string }> = [];
	const statuses: string[] = [];
	const lines: string[] = [];
	const harness = await createHarness({
		models: [{ id: "faux-64k", contextWindow: 64_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false }, retry: { baseDelayMs: 1, maxRetries: 2 }, ...settings } as never,
		extensionFactories: [
			workExtension,
			createContextEngine({ stats, env: {}, log: (line) => lines.push(line), ...engine }),
		],
	});
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({
			notify: (message, type) => notices.push({ message, type }),
			setStatus: (_key, text) => {
				if (text) statuses.push(text);
			},
		}),
	});
	installProviderSim(harness);
	const model = scriptedModel(harness);
	return { stats, notices, statuses, lines, harness, model };
}

async function doctor(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
	const before = t.notices.length;
	await t.harness.session.prompt("/penpi doctor");
	return t.notices
		.slice(before)
		.map((n) => n.message)
		.join("\n");
}

describe("D1: fault injection", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d1 off by default: no faults, no flag, doctor says off", async () => {
		const t = await setup({});
		harnesses.push(t.harness);
		await runPrompts(t.harness, t.model, { prompts: 1, turns: 10 });
		const text = await doctor(t);
		expect(t.stats.faults).toHaveLength(0);
		expect(t.statuses.some((s) => s.includes("FAULTS"))).toBe(false);
		expect(text).toContain("fault injection: off");
	});

	it("d1 schedule: each kind fires where asked, loudly, and the engine recovers", async () => {
		const t = await setup({ faults: "overflow=at:5;output-limit=at:9;length=at:13" });
		harnesses.push(t.harness);
		await runPrompts(t.harness, t.model, { prompts: 2, turns: 12 });
		const text = await doctor(t);
		const faultLines = t.lines.filter((l) => l.includes("FAULT INJECTED"));
		const faultNotices = t.notices.filter((n) => n.message.includes("FAULT INJECTED"));
		report("d1", ENGINE_LABEL, "schedule", {
			faults: t.stats.faults,
			startup: t.lines.filter((l) => l.includes("FAULT INJECTION ACTIVE")),
			faultLines,
			providerErrors: t.stats.providerErrors,
			overflowRetries: t.stats.overflowRetries,
			outputRetries: t.stats.outputRetries,
			lengthContinuations: t.stats.lengthContinuations,
			status: t.statuses.at(-1),
			doctorLine: text.split("\n").find((l) => l.startsWith("fault injection")),
			turns: t.model.cursor,
		});
		expect(t.stats.faults).toEqual([
			{ response: 5, kind: "overflow" },
			{ response: 9, kind: "output-limit" },
			{ response: 13, kind: "length" },
		]);
		// Loud: a startup banner (log and UI), and one log line and one warning per fault.
		expect(t.lines.some((l) => l.includes("FAULT INJECTION ACTIVE"))).toBe(true);
		expect(t.notices.some((n) => n.message.includes("FAULT INJECTION ACTIVE") && n.type === "warning")).toBe(true);
		expect(faultLines).toHaveLength(3);
		expect(faultNotices).toHaveLength(3);
		expect(t.statuses.at(-1)).toMatch(/^FAULTS ON · ctx /);
		expect(text).toContain("fault injection: ON (overflow at 5; output-limit at 9; length at 13); 3 injected so far");
		// The engine handled each one as it would a real fault.
		expect(t.stats.overflowRetries).toBe(1);
		// The output-limit fault quotes the request's max_tokens. When that number contains a digit run Pi's
		// retry regex matches anywhere ("524", "500", "429", ...), Pi retries the error itself, already with
		// the ceiling learned at message_end (E7.14), and the engine has nothing left to retry. Which one
		// happens depends on the exact max_tokens (it varied between 1524 and 1527 across runs), so the test
		// accepts either, as long as the request is retried exactly once.
		const outputFault = faultLines.find((l) => l.includes("(output-limit)")) ?? "";
		const outputError = outputFault.slice(outputFault.indexOf("[context-engine injected fault]"));
		const piRetried = isRetryableAssistantError({
			role: "assistant",
			stopReason: "error",
			errorMessage: outputError,
		} as never);
		expect(t.stats.outputRetries + (piRetried ? 1 : 0)).toBe(1);
		expect(t.stats.providerErrors.map((e) => e.class)).toEqual(["context-overflow", "output-limit"]);
		expect(t.model.cursor).toBe(24);
	});

	// Behaviours without a test, item 9: when several kinds fire on one response, overflow beats output-limit
	// beats length.
	it("d1 priority: overflow beats output-limit beats length on one response", async () => {
		const t = await setup({ faults: "overflow=at:5;output-limit=at:5,9;length=at:5,9,13" });
		harnesses.push(t.harness);
		await runPrompts(t.harness, t.model, { prompts: 2, turns: 12 });
		expect(t.stats.faults).toEqual([
			{ response: 5, kind: "overflow" },
			{ response: 9, kind: "output-limit" },
			{ response: 13, kind: "length" },
		]);
		expect(t.lines.filter((l) => l.includes("FAULT INJECTED"))).toHaveLength(3);
	});

	it("d1 probability: seeded and repeatable", async () => {
		const counts: number[][] = [];
		for (let run = 0; run < 2; run++) {
			const t = await setup({ faults: { length: { probability: 0.2 }, seed: 7 } });
			harnesses.push(t.harness);
			await runPrompts(t.harness, t.model, { prompts: 2, turns: 15 });
			counts.push(t.stats.faults.map((f) => f.response));
		}
		report("d1", ENGINE_LABEL, "probability", { responses: counts });
		expect(counts[0].length).toBeGreaterThan(0);
		expect(counts[1]).toEqual(counts[0]);
	});

	it("d1 env var PENPI_FAULTS turns it on; the spec parser reads both forms", async () => {
		expect(FAULTS_ENV).toBe("PENPI_FAULTS");
		expect(parseFaultSpec("overflow=every:7;output-limit=p:0.1;length=at:3,9;seed=42")).toEqual({
			overflow: { every: 7 },
			outputLimit: { probability: 0.1 },
			length: { at: [3, 9] },
			seed: 42,
		});
		expect(parseFaultSpec('{"overflow":{"every":3}}')).toEqual({ overflow: { every: 3 } });
		const t = await setup({ env: { [FAULTS_ENV]: "length=every:4" } });
		harnesses.push(t.harness);
		await runPrompts(t.harness, t.model, { prompts: 1, turns: 9 });
		expect(t.stats.faultsActive).toBe("length every 4");
		expect(t.stats.faults.map((f) => f.response)).toEqual([4, 8]);
	});

	const guards: Array<[string, Partial<EngineOptions>, Record<string, unknown>, string]> = [
		[
			"PENPI_PRODUCTION=1",
			{ env: { [FAULTS_ENV]: "overflow=every:2", [PRODUCTION_ENV]: "1" } },
			{},
			"PENPI_PRODUCTION=1",
		],
		["the production option", { faults: "overflow=every:2", production: true }, {}, "the production option"],
	];
	for (const [label, engine, settings, reason] of guards) {
		it(`d1 guard: ${label} refuses fault injection`, async () => {
			const warnings: string[] = [];
			const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
				warnings.push(args.map(String).join(" "));
			});
			onTestFinished(() => spy.mockRestore());
			const t = await setup(engine, settings);
			harnesses.push(t.harness);
			await runPrompts(t.harness, t.model, { prompts: 1, turns: 8 });
			const text = await doctor(t);
			report("d1", ENGINE_LABEL, `guard.${label}`, {
				faults: t.stats.faults.length,
				refused: t.stats.faultsRefused,
				notices: t.notices.filter((n) => n.message.includes("REFUSED")),
				doctorLine: text.split("\n").find((l) => l.startsWith("fault injection")),
			});
			expect(t.stats.faults).toHaveLength(0);
			expect(t.stats.faultsRefused).toContain(reason);
			expect(t.notices.some((n) => n.message.includes("FAULT INJECTION REFUSED") && n.type === "error")).toBe(true);
			expect(t.lines.some((l) => l.includes("FAULT INJECTION REFUSED"))).toBe(true);
			// R5: a refused switch never announces ACTIVE, in the log or on the console.
			expect(t.lines.some((l) => l.includes("FAULT INJECTION ACTIVE"))).toBe(false);
			expect(warnings.some((w) => w.includes("FAULT INJECTION ACTIVE"))).toBe(false);
			expect(t.statuses.some((s) => s.includes("FAULTS"))).toBe(false);
			expect(text).toMatch(/fault injection: REFUSED \(.*production.*\)/);
			expect(t.model.cursor).toBe(8);
		});
	}

	it("d1 guard reads the real process environment", async () => {
		const saved = { faults: process.env[FAULTS_ENV], production: process.env[PRODUCTION_ENV] };
		process.env[FAULTS_ENV] = "overflow=every:2";
		process.env[PRODUCTION_ENV] = "true";
		try {
			const t = await setup({ env: undefined });
			harnesses.push(t.harness);
			await runPrompts(t.harness, t.model, { prompts: 1, turns: 6 });
			expect(t.stats.faults).toHaveLength(0);
			expect(t.stats.faultsRefused).toBe("PENPI_PRODUCTION=true");
		} finally {
			if (saved.faults === undefined) delete process.env[FAULTS_ENV];
			else process.env[FAULTS_ENV] = saved.faults;
			if (saved.production === undefined) delete process.env[PRODUCTION_ENV];
			else process.env[PRODUCTION_ENV] = saved.production;
		}
	});
});
