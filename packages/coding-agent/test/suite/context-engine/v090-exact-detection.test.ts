/**
 * 0.9.0, commit 5 (design section 5): detection on exact counts. Once the exactness gate is set (three judged samples in
 * a row that match on deltas and totals), growth is judged on raw deltas, a sample under its request's text count is
 * evidence, and the exact repeat is reversed. Assumed names, mixed samples and fallback samples stay on the fallback
 * rules. The provider here counts with o200k, the model's own tokenizer, plus a few template tokens a message.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../../.pi/extensions/penpi/engine/estimator.ts";
import { type ExactParts, exactRequest } from "../../../../../.pi/extensions/penpi/engine/exact.ts";
import type { ReasoningRule } from "../../../../../.pi/extensions/penpi/engine/tokenizers/reasoning.ts";
import { endExactSessions, exactReady, exactSession, prompt } from "./exact-session.ts";
import { finalTurn, resendAnswered } from "./helpers.ts";
import { o200kTokens } from "./tokenizers.ts";

afterEach(endExactSessions);

const gateSet = (lines: string[]) => lines.some((l) => l.includes("exactness gate set"));
const evidence = (lines: string[]) => lines.filter((l) => l.includes("silent truncation evidence"));

describe("0.9.0: the exactness gate", () => {
	it("an honest provider counting with the model's tokenizer sets the gate, and a long session with cuts detects nothing", async () => {
		const s = await exactSession("gpt-4o-test", { count: o200kTokens });
		await exactReady(s);
		for (let p = 1; p <= 10; p++) await prompt(s, [6_000, 10_000, 4_000], p);
		expect(gateSet(s.lines)).toBe(true);
		expect(s.stats.cuts.length).toBeGreaterThan(0);
		expect(evidence(s.lines)).toEqual([]);
		expect(s.stats.plateaus).toEqual([]);
	});

	it("a provider that already drops messages never sets it: its totals fall under the text count", async () => {
		const s = await exactSession("gpt-4o-test", {
			count: o200kTokens,
			// Below the second request's size: it drops messages from the first judged sample on.
			sim: { silentLimit: 2_000, silentReport: "remainder" },
		});
		await exactReady(s);
		for (let p = 1; p <= 4; p++) await prompt(s, [8_000, 6_000], p);
		expect(gateSet(s.lines)).toBe(false);
	});

	it("an assumed name never sets it, and its counting line says assumed", async () => {
		const s = await exactSession("srv-assumed", {
			count: o200kTokens,
			engine: { exactModels: { "faux/srv-assumed": { entry: "o200k", status: "assumed" } } },
		});
		await exactReady(s);
		for (let p = 1; p <= 5; p++) await prompt(s, [6_000, 4_000], p);
		expect(s.reports).toEqual(['{"k":"counting","path":"exact","entry":"o200k","reason":null,"assumed":true}']);
		expect(gateSet(s.lines)).toBe(false);
	});

	for (const scale of [0.8, 1.3])
		it(`a provider counting ${scale} times the tokenizer never sets it, and nothing is detected`, async () => {
			const s = await exactSession("gpt-4o-test", { count: (t) => Math.round(o200kTokens(t) * scale) });
			await exactReady(s);
			for (let p = 1; p <= 8; p++) await prompt(s, [6_000, 10_000, 4_000], p);
			expect(gateSet(s.lines)).toBe(false);
			expect(s.stats.plateaus).toEqual([]);
		});
});

describe("0.9.0: detection once the gate is set", () => {
	it("a server that keeps only its limit and reports exactly it is caught by exact growth", async () => {
		const s = await exactSession("gpt-4o-test", { count: o200kTokens, sim: { silentLimit: 14_000 } });
		await exactReady(s);
		for (let p = 1; p <= 8; p++) await prompt(s, [6_000, 8_000], p);
		expect(gateSet(s.lines)).toBe(true);
		expect(evidence(s.lines).some((l) => /exact append \d+, reported usage/.test(l))).toBe(true);
		expect(s.stats.plateaus.length).toBeGreaterThan(0);
		// Detected within three truncated requests.
		const truncated = s.sim.calls.findIndex((c) => c.processedTokens < c.promptTokens);
		const detected = s.lines.findIndex((l) => l.includes("silent truncation:") && l.includes("window ->"));
		expect(truncated).toBeGreaterThan(0);
		expect(detected).toBeGreaterThan(0);
	});

	it("a sample under its request's text count is evidence, whatever its delta (the absolute bound)", async () => {
		let calls = 0;
		const s = await exactSession("gpt-4o-test", {
			count: o200kTokens,
			// From the twelfth call on, the provider reports 6,000 tokens fewer than it was sent.
			sim: { servedBy: () => (++calls >= 12 ? { offset: 6_000 } : {}) },
		});
		await exactReady(s);
		for (let p = 1; p <= 6; p++) await prompt(s, [8_000, 6_000], p);
		expect(gateSet(s.lines)).toBe(true);
		expect(evidence(s.lines).some((l) => l.includes("under the request's exact text count"))).toBe(true);
	});

	it("a surplus beyond the tolerance is a fallback sample, logged, never evidence", async () => {
		let calls = 0;
		const s = await exactSession("gpt-4o-test", {
			count: o200kTokens,
			// One call reports 3,000 tokens more than it was sent: over a fifth of its append.
			sim: { servedBy: () => (++calls === 12 ? { offset: -3_000 } : {}) },
		});
		await exactReady(s);
		for (let p = 1; p <= 6; p++) await prompt(s, [8_000, 6_000], p);
		expect(gateSet(s.lines)).toBe(true);
		expect(s.lines.some((l) => l.includes("exact count off"))).toBe(true);
		expect(evidence(s.lines)).toEqual([]);
	});

	it("a provider whose count drifts by up to 2% per kind of content, either way, sets the gate and detects nothing", async () => {
		// Each tool result counted at its own scale, 0.98 to 1.02, as a server's tokenizer version or normalizing can.
		const scale = (t: string) => 0.98 + 0.04 * (((t.length * 2_654_435_761) % 1_000) / 1_000);
		const s = await exactSession("gpt-4o-test", { count: (t) => Math.round(o200kTokens(t) * scale(t)) });
		await exactReady(s);
		for (let p = 1; p <= 10; p++) await prompt(s, [6_000, 10_000, 4_000], p);
		expect(gateSet(s.lines)).toBe(true);
		expect(s.stats.cuts.length).toBeGreaterThan(0);
		expect(evidence(s.lines)).toEqual([]);
		expect(s.stats.plateaus).toEqual([]);
	});

	it("an identical resend of the maximum is no evidence: its exact size is the maximum's", async () => {
		const s = await exactSession("gpt-4o-test", { count: o200kTokens, window: 200_000 });
		await exactReady(s);
		for (let p = 1; p <= 5; p++) await prompt(s, [8_000, 6_000], p);
		expect(gateSet(s.lines)).toBe(true);
		// The last request, sent again from the same point: it reports the same count, the maximum.
		s.model.push(finalTurn("done 5"));
		await resendAnswered(s.harness, "done 5");
		expect(s.sim.calls.at(-1)!.promptTokens).toBe(s.sim.calls.at(-2)!.promptTokens);
		expect(evidence(s.lines)).toEqual([]);
	});
});

/** Parts of a message, for exactRequest: `raw` tokens, its reasoning, and whether it calls tools. */
function part(raw: number, reasoning = 0, calls = false): ExactParts {
	return { tokens: raw + 4, reasoning, band: 0, raw, images: false, text: 0, said: 10, calls };
}
const msg = (role: string): AgentMessage => ({ role }) as unknown as AgentMessage;

describe("0.9.0: templates that drop earlier reasoning (exactRequest)", () => {
	// user, assistant (reasoning 50, a tool call), tool result, assistant (reasoning 70, a final answer), user, assistant
	// (reasoning 90, a tool call).
	const sent = ["user", "assistant", "toolResult", "assistant", "user", "assistant"].map(msg);
	const parts = [part(100), part(200, 50, true), part(300), part(150, 70), part(40), part(120, 90, true)];
	const all = 100 + 200 + 300 + 150 + 40 + 120;
	const rendered = (rule: ReasoningRule | undefined) => exactRequest(sent, parts, undefined, rule).rendered;

	it("keep, none and not pinned render every turn as counted", () => {
		expect(rendered("keep")).toBe(all);
		expect(rendered("none")).toBe(all);
		expect(rendered(undefined)).toBe(all);
	});

	it("drop: reasoning before the last user message leaves the prompt", () => {
		expect(rendered("drop")).toBe(all - 50 - 70);
	});

	it("after-final: reasoning up to the last final answer leaves the prompt; gpt-oss's rule takes a tool-call turn's text too", () => {
		expect(rendered("after-final")).toBe(all - 50 - 70);
		expect(rendered("after-final-text")).toBe(all - 50 - 70 - 10);
		// With no final answer yet, everything is kept.
		const noFinal = [part(100), part(200, 50, true), part(300), part(40), part(120, 90, true)];
		const s2 = ["user", "assistant", "toolResult", "user", "assistant"].map(msg);
		expect(exactRequest(s2, noFinal, undefined, "after-final").rendered).toBe(100 + 200 + 300 + 40 + 120);
		expect(exactRequest(s2, noFinal, undefined, "drop").rendered).toBe(100 + 150 + 300 + 40 + 120);
	});

	it("an unpinned model's append across a user message after reasoning is a fallback sample; so is reasoning for a template with none", () => {
		expect(exactRequest(sent, parts, 4, undefined).fallback).toMatch(/isn't pinned/);
		expect(exactRequest(sent, parts, 4, "drop").fallback).toBeUndefined();
		expect(exactRequest(sent, parts, 5, "none").fallback).toMatch(/renders none/);
		// An append with no user message after the reasoning crosses nothing.
		expect(exactRequest(sent, parts, 5, undefined).fallback).toBeUndefined();
	});
});
