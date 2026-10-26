/**
 * D15 (port): the continuation after a reasoning-only length stop.
 *   A length stop with no visible text and no tool call spent the whole output limit on reasoning, which
 *   Pi does not replay; "continue exactly where it stopped" makes the model reason again from scratch
 *   (E4 S-high: 22 such stops, 45% resolved at the next attempt). It gets its own message
 *   (reasoningOnlyContinuation "answer", the default; "continue" keeps p4's). The cap stays at
 *   maxLengthContinuations (3) per run, also for repeated reasoning-only stops, and resets for the next run.
 */

import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import {
	CONTINUE_TYPE,
	createContextEngine,
	type EngineOptions,
	LENGTH_CONTINUATION,
	newStats,
	REASONING_ONLY_CONTINUATION,
} from "./engine.ts";
import { finalTurn, scriptedModel } from "./helpers.ts";

const MAX_TOKENS = 1_000;

/** A response cut at the output limit that produced only reasoning (faux usage.output = chars / 4). */
const reasoningOnly = (): AssistantMessage =>
	fauxAssistantMessage(
		[{ type: "thinking", thinking: "r".repeat(MAX_TOKENS * 4 + 40), thinkingSignature: "reasoning" }],
		{
			stopReason: "length",
		},
	);

describe("D15: continuation after a reasoning-only length stop", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Partial<EngineOptions> = {}) {
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: MAX_TOKENS, reasoning: true }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({ stats, log: (l) => lines.push(l), ...options })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { stats, lines, harness, model: scriptedModel(harness) };
	}

	const continuations = (h: Harness) =>
		h.sessionManager
			.getEntries()
			.flatMap((e) => (e.type === "custom_message" && e.customType === CONTINUE_TYPE ? [String(e.content)] : []));

	/** The last message of the last request the provider received, and which continuation text it carries. */
	const fragment = (text: string) => JSON.stringify(text.slice(0, 60)).slice(1, -1);
	const lastSent = (h: { model: { requests: string[][] } }) => {
		const message = h.model.requests.at(-1)?.at(-1) ?? "";
		return {
			answer: message.includes(fragment(REASONING_ONLY_CONTINUATION)),
			resume: message.includes(fragment(LENGTH_CONTINUATION)),
		};
	};

	it("d15 a reasoning-only stop gets the answer-directly message", async () => {
		const h = await setup();
		h.model.push(() => reasoningOnly(), finalTurn("The answer."));
		await h.harness.session.prompt("Count the events in the log.");
		expect(continuations(h.harness)).toEqual([REASONING_ONLY_CONTINUATION]);
		expect(h.model.requests.at(-1)?.some((m) => m.includes("used the whole output limit on reasoning"))).toBe(true);
		expect(lastSent(h)).toEqual({ answer: true, resume: false });
		expect(h.stats.reasoningOnlyStops).toBe(1);
		expect(h.lines.some((l) => l.includes("length stop: continuation 1/3 (reasoning only, answer message)"))).toBe(
			true,
		);
	});

	it("d15 a stop that wrote visible text keeps the continue-where-it-stopped message", async () => {
		const h = await setup();
		h.model.push(
			finalTurn(`The answer begins ${"x".repeat(MAX_TOKENS * 4 + 40)}`, "length"),
			finalTurn("...the rest."),
		);
		await h.harness.session.prompt("Write the long answer.");
		expect(continuations(h.harness)).toEqual([LENGTH_CONTINUATION]);
		// What the provider received last: the continue-where-it-stopped message.
		expect(lastSent(h)).toEqual({ answer: false, resume: true });
		expect(h.stats.reasoningOnlyStops).toBe(0);
	});

	it('d15 reasoningOnlyContinuation "continue" sends the old message after a reasoning-only stop', async () => {
		const h = await setup({ reasoningOnlyContinuation: "continue" });
		h.model.push(() => reasoningOnly(), finalTurn("The answer."));
		await h.harness.session.prompt("Count the events in the log.");
		expect(continuations(h.harness)).toEqual([LENGTH_CONTINUATION]);
		expect(lastSent(h)).toEqual({ answer: false, resume: true });
		expect(h.lines.some((l) => l.includes("(reasoning only, continue message)"))).toBe(true);
	});

	it("d15 repeated reasoning-only stops: at most 3 continuations per run, reset for the next run", async () => {
		const h = await setup();
		h.model.push(...Array.from({ length: 5 }, () => () => reasoningOnly()));
		await h.harness.session.prompt("Count the events in the log.");
		// The original response and 3 continuations; the fourth stop ends the run.
		expect(h.model.requests).toHaveLength(4);
		expect(continuations(h.harness)).toEqual(Array(3).fill(REASONING_ONLY_CONTINUATION));
		// Each continuation request ends with the answer-directly message.
		for (const request of h.model.requests.slice(1))
			expect(lastSent({ model: { requests: [request] } })).toEqual({ answer: true, resume: false });
		h.model.push(finalTurn("Done."));
		const before = h.model.requests.length;
		await h.harness.session.prompt("Try again.");
		// The next run starts with its own budget: one continuation after the leftover stop, then the answer.
		expect(h.model.requests.length - before).toBe(2);
		expect(lastSent(h)).toEqual({ answer: true, resume: false });
		expect(continuations(h.harness)).toHaveLength(4);
	});
});
