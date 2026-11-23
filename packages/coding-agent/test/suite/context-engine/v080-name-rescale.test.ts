/**
 * 0.8.0, ADR 0034, through the detector: what calibrate records on each sample (marginal, its append chain) reaches
 * the names at detection. engine/name-rescale.test.ts checks the rule on figures from the E2; this runs a session.
 *   1. The shape of data.o200k.1m.silent-messages: a server that drops the oldest messages truncates request A by a
 *      little, and A reads marginal. Request B drops the same message, so its usage grows by exactly its append, and at
 *      the ratio A lowered it is expected just under the learned window's line. A strong sample detects. B is named
 *      only by the rescale.
 *   2. An honest marginal sample and a real fall of the ratio in the same chain: the next clean sample clears the
 *      marginal sample, so the honest answers near the window are not named. Without the clearing, the rescale would
 *      raise them back to the ratio from before the marginal sample, over the line.
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { resetEntryIds } from "./deterministic-ids.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	finalTurn,
	installProviderSim,
	type ProviderSim,
	runPrompts,
	scriptedModel,
	syntheticText,
	workExtension,
} from "./helpers.ts";

const MODEL = { id: "srv-200k", contextWindow: 200_000, maxTokens: 16_384 };
const harnesses: Harness[] = [];
const RESCALE_LINE = "named at the ratio from before their chain's first doubtful sample";

async function session(options: Record<string, unknown>) {
	const stats = newStats();
	const lines: string[] = [];
	// The same session directory (cwd is in the system prompt) and entry ids for every session, so the runs with the
	// rule on and off send the same requests: the harness names its directory from the clock and Math.random.
	resetEntryIds();
	const clock = vi.spyOn(Date, "now").mockReturnValue(1_792_000_000_000);
	const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
	const created = createHarness({
		models: [MODEL],
		settings: { compaction: { enabled: false } },
		extensionFactories: [workExtension, createContextEngine({ stats, ...options, log: (l) => lines.push(l) })],
	});
	clock.mockRestore();
	random.mockRestore();
	const harness = await created;
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return { stats, lines, harness };
}

/** The turns named at detection, in order (call i answers turn i + 1). */
const namedTurns = (stats: ReturnType<typeof newStats>) =>
	stats.plateauReports.flatMap((r) => r.turns.map((t) => t.turn ?? 0)).sort((a, b) => a - b);

/** The server's real context in the first test. The first prompt (about 1,300 tokens) is the message it drops. */
const LIMIT = 60_000;

async function caseTwo(rescale: boolean) {
	const s = await session({ silentNameRescale: rescale });
	const sim = installProviderSim(s.harness, { silentLimit: LIMIT, silentReport: "remainder" });
	const model = scriptedModel(s.harness, 200);
	// Each answer picks the next tool result's size (tokens; chars / 4) from the request it answers:
	//   grow by 8,000 until the next request would pass LIMIT - 4,000; then fill to about LIMIT - 1,400;
	//   A: 2,200, which overshoots LIMIT by about 800, so the server drops the 1,300-token first prompt (usage grows by
	//   about 900 of 2,200: marginal); B: 150, which still fits once the prompt is dropped (usage grows by exactly its
	//   append); then 3,000, which drops an 8,000-token result too (usage falls: strong evidence, detection).
	let phase: "grow" | "fill" | "a" | "b" | "drop" | "after" = "grow";
	const step = (n: number) => () => {
		const tokens = sim.calls.at(-1)?.promptTokens ?? 0;
		if (phase === "grow" && tokens + 8_000 >= LIMIT - 4_000) phase = "fill";
		else if (phase === "fill") phase = "a";
		else if (phase === "a") phase = "b";
		else if (phase === "b") phase = "drop";
		else if (phase === "drop") phase = "after";
		const size =
			phase === "grow"
				? 8_000
				: phase === "fill"
					? LIMIT - 1_400 - tokens - 20
					: phase === "a"
						? 2_200
						: phase === "b"
							? 150
							: phase === "drop"
								? 3_000
								: 200;
		return fauxAssistantMessage(
			[fauxText(`Step ${n}.`), fauxToolCall("work", { size: Math.max(1, size) * 4, seed: n }, { id: `call-${n}` })],
			{ stopReason: "toolUse" },
		);
	};
	for (let n = 0; n < 14; n++) model.push(step(n));
	model.push(finalTurn("done"));
	await s.harness.session.prompt(`First task: ${syntheticText(5_200, 3).replace(/\s+/g, " ")}`);
	return { ...s, sim };
}

/** Tokens a call's provider leaves out of its count, from the call `from` on: content that counts fewer tokens than
 * the engine estimates, for real (no truncation). The last call goes to a server that drops old messages. */
async function honestFall(rescale: boolean, from: number, last: number) {
	const s = await session({ silentNameRescale: rescale });
	let sim: ProviderSim | undefined;
	sim = installProviderSim(s.harness, {
		servedBy: (index) => ({
			// 560 of the first 1,000-token append (marginal), then 150 of each later one: the ratio falls for real.
			offset: index < from ? undefined : 560 + 150 * (index - from),
			drops: index === last ? (sim?.calls.at(-2)?.promptTokens ?? 0) - 1_000 : undefined,
		}),
	});
	const model = scriptedModel(s.harness);
	await runPrompts(s.harness, model, { prompts: 1, turns: last + 3, min: 4_000, spread: 0 });
	return { ...s, sim };
}

describe("ADR 0034 through the detector", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("the shape of data.o200k.1m.silent-messages: the answer after a marginal truncated one, grown by exactly its append, is named", async () => {
		const on = await caseTwo(true);
		const off = await caseTwo(false);
		const calls = on.sim.calls;
		const a = calls.findIndex((c) => c.truncatedInput);
		const b = a + 1;
		// The premise: A dropped only the first prompt and read marginal; B dropped the same and grew by its append.
		expect(calls[a].droppedMessages).toBe(1);
		expect(on.lines.filter((l) => l.includes("silent truncation marginal sample:"))).toHaveLength(1);
		expect(calls[b].truncatedInput).toBe(true);
		expect(calls[b].droppedMessages).toBe(1);
		expect(calls[b].processedTokens - calls[a].processedTokens).toBe(calls[b].promptTokens - calls[a].promptTokens);
		expect(on.stats.plateaus).toHaveLength(1);
		// Requests are the same with the rule on and off: it changes names only.
		expect(off.sim.calls.map((c) => c.promptTokens)).toEqual(calls.map((c) => c.promptTokens));
		expect(off.stats.plateaus).toEqual(on.stats.plateaus);
		// Off, B is not named; on, it is, and nothing else changes.
		expect(namedTurns(off.stats)).not.toContain(b + 1);
		expect(namedTurns(on.stats)).toEqual([...namedTurns(off.stats), b + 1].sort((x, y) => x - y));
		expect(on.lines.some((l) => l.includes(`1 more answer(s) ${RESCALE_LINE}`))).toBe(true);
	});

	it("an honest marginal sample and a real fall of the ratio in the same chain: no extra names", async () => {
		const FROM = 14;
		const LAST = 22;
		const on = await honestFall(true, FROM, LAST);
		const off = await honestFall(false, FROM, LAST);
		// The premise: one marginal sample at FROM, cleared by the next clean sample; nothing truncated before LAST.
		expect(on.lines.filter((l) => l.includes("silent truncation marginal sample:"))).toHaveLength(1);
		expect(on.lines.some((l) => l.includes("silent truncation marginal samples cleared"))).toBe(true);
		expect(on.sim.calls.slice(0, LAST).some((c) => c.truncatedInput)).toBe(false);
		expect(on.sim.calls[LAST].truncatedInput).toBe(true);
		expect(on.stats.plateaus).toHaveLength(1);
		// The rescale adds no name: the marginal sample was judged honest when it was cleared. (Today's D14 names the
		// answer before the truncated one in both runs; that is not this rule's.) Without the clearing, turn LAST - 1
		// would be named too: the ratio from before the marginal sample puts it over the line.
		expect(namedTurns(on.stats)).toEqual(namedTurns(off.stats));
		expect(on.lines.some((l) => l.includes(RESCALE_LINE))).toBe(false);
	});
});
