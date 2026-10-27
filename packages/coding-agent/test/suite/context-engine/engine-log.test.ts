/**
 * Port (Addendum 1, items 2 and 3): the opt-in engine log and per-request telemetry. With PENPI_ENGINE_LOG
 * set, the engine's lines (cuts, pin decisions, provider errors) and one telemetry report per request go to
 * that file, and the report is also emitted as the status context-engine.telemetry. Without it, neither
 * happens. The log carries no prompt or message text: a session whose prompt, tool output and provider error
 * each contain a marker leaves no marker in the file.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPenpiEngine } from "../../../../../.pi/extensions/penpi/engine/entry.ts";
import { TELEMETRY_STATUS } from "../../../../../.pi/extensions/penpi/engine/telemetry.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { finalTurn, installProviderSim, scriptedModel, syntheticText } from "./helpers.ts";

// Every log writer the entry creates, by path: without PENPI_ENGINE_LOG there must be none.
const writers = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("../../../../../.pi/extensions/penpi/engine/telemetry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../../.pi/extensions/penpi/engine/telemetry.ts")>();
	return {
		...actual,
		engineLogWriter: (path: string) => {
			writers.paths.push(path);
			return actual.engineLogWriter(path);
		},
	};
});

const PROMPT_MARK = "SECRET-PROMPT-7f3";
const TOOL_MARK = "SECRET-TOOL-9c1";
const ERROR_MARK = "SECRET-ERR-2b8";

/** A tool whose output carries a marker. */
function markedTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "work",
		label: "work",
		description: "Do a unit of work.",
		parameters: Type.Object({ size: Type.Number(), seed: Type.Number() }),
		execute: async (_id, { size, seed }) => ({
			content: [{ type: "text", text: `${TOOL_MARK} ${syntheticText(size, seed)}` }],
			details: {},
		}),
	});
}

describe("PENPI_ENGINE_LOG: the engine log and telemetry", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		writers.paths.length = 0;
	});
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function session(logPath: string | undefined) {
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				markedTool,
				(pi) =>
					void installPenpiEngine(
						pi,
						{ registerCommand: true },
						{ settings: {}, env: { PENPI_ENGINE_LOG: logPath } },
					),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ setStatus: (key, text) => statuses.push({ key, text }) }),
		});
		// The provider rejects once, with an error that quotes request content.
		let rejected = false;
		const sim = installProviderSim(harness, {
			realLimit: (_call, tokens) => {
				if (rejected || tokens <= 12_000) return undefined;
				rejected = true;
				return 12_000;
			},
			overflowMessage: (tokens, limit) =>
				`prompt is too long: ${tokens} tokens > ${limit} maximum (request began "${ERROR_MARK} ...")`,
		});
		const model = scriptedModel(harness, 400);
		for (let p = 0; p < 4; p++) {
			for (let t = 0; t < 8; t++)
				model.push(() =>
					fauxAssistantMessage([fauxToolCall("work", { size: 6_000, seed: p * 10 + t }, { id: `w-${p}-${t}` })], {
						stopReason: "toolUse",
					}),
				);
			model.push(finalTurn(`done ${p}`));
			await harness.session.prompt(`${PROMPT_MARK} task ${p}: process the next batch.`);
		}
		return { sim, statuses: statuses.filter((s) => s.key === TELEMETRY_STATUS) };
	}

	it("with PENPI_ENGINE_LOG: engine lines and telemetry in the file, telemetry as a status, no prompt or message text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "engine-log-"));
		const path = join(dir, "engine.log");
		const { sim, statuses } = await session(path);
		expect(writers.paths).toEqual([path]);
		const log = readFileSync(path, "utf8");
		const lines = log.trim().split("\n");
		// Every line is timestamped.
		for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z /);
		expect(log).toMatch(/ \[a\] cut #1 /);
		expect(log).toMatch(/ \[a\] pin #1: /);
		expect(log).toMatch(/ \[a\] provider error \(context-overflow; /);
		const reports = lines.filter((l) => / telemetry \{/.test(l)).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
		expect(reports.length).toBe(sim.calls.length);
		expect(reports[0]).toMatchObject({ k: "req", n: 1 });
		expect(Array.isArray(reports[0].tools)).toBe(true);
		expect(reports.at(-1).cuts).toBeGreaterThan(0);
		// The same reports as the status, one per request.
		expect(statuses).toHaveLength(sim.calls.length);
		expect(JSON.parse(statuses[0].text ?? "{}")).toEqual(reports[0]);
		// No prompt, tool output or provider error text.
		for (const mark of [PROMPT_MARK, TOOL_MARK, ERROR_MARK]) expect(log).not.toContain(mark);
	});

	for (const [label, value] of [
		["unset", undefined],
		["empty", "  "],
	] as const)
		it(`without PENPI_ENGINE_LOG (${label}): no log writer, so no file, and no telemetry status`, async () => {
			const { sim, statuses } = await session(value);
			expect(sim.calls.length).toBeGreaterThan(10);
			expect(statuses).toHaveLength(0);
			expect(writers.paths).toEqual([]);
		});
});
