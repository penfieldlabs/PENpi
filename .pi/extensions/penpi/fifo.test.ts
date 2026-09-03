import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	deriveCalibration,
	FIFO_NOTICE_CUSTOM_TYPE,
	isProtected,
	newFifoTriggerState,
	normalizeReportedTokens,
	planFifo,
	planFifoFromUsage,
} from "./fifo.ts";

type Msg = Parameters<typeof planFifo>[0][number];

const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 0 }) as Msg;
const asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: 0 }) as Msg;
const briefing = () =>
	({ role: "custom", customType: "penpi-briefing", content: "B".repeat(800), display: false, timestamp: 0 }) as Msg;

function convo() {
	const msgs = [briefing()];
	for (let i = 0; i < 20; i++)
		msgs.push(i % 2 === 0 ? user(`U${i} ${"A".repeat(400)}`) : asst(`R${i} ${"A".repeat(400)}`));
	return msgs;
}
const cfg = { contextCeiling: 0.75, contextFloor: 0.5 };

const total = (msgs: Msg[]) => msgs.reduce((a, m) => a + estimateTokens(m), 0);

/** Roles convertToLlm maps to `user` — a pruned window must START with one of these. */
const USER_CONVERTIBLE = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);

describe("planFifo", () => {
	it("does not trigger under the ceiling and returns the same array", () => {
		const msgs = convo();
		const plan = planFifo(msgs, 1_000_000, 1000, cfg);
		expect(plan.triggered).toBe(false);
		expect(plan.messages).toBe(msgs);
	});

	it("prunes oldest to the floor when over the ceiling", () => {
		const msgs = convo();
		const total = msgs.reduce((a, m) => a + estimateTokens(m), 0) + 50;
		const plan = planFifo(msgs, 1000, total, cfg);
		expect(plan.triggered).toBe(true);
		expect(plan.dropped).toBeGreaterThan(0);
		expect(plan.messages.includes(msgs[msgs.length - 1])).toBe(true); // newest kept
		expect(plan.messages.includes(msgs[1])).toBe(false); // oldest turn dropped
		expect(plan.keptMessageTokens + 50).toBeLessThanOrEqual(cfg.contextCeiling * 1000);
	});

	it("always keeps protected penpi- messages", () => {
		const msgs = convo();
		const total = msgs.reduce((a, m) => a + estimateTokens(m), 0) + 50;
		const plan = planFifo(msgs, 1000, total, cfg);
		expect(plan.messages.some(isProtected)).toBe(true);
	});

	it("preserves original order (realistic budget: several messages survive)", () => {
		const msgs = convo();
		// Realistic currentTokens (small real overhead) — NOT a degenerate huge value,
		// which zeroes the budget and trivially keeps a single message.
		const plan = planFifo(msgs, 1000, total(msgs) + 50, cfg);
		expect(plan.triggered).toBe(true);
		expect(plan.messages.length).toBeGreaterThan(1);
		const idxs = plan.messages.map((m) => msgs.indexOf(m));
		expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
	});

	it("drops the briefing when it genuinely cannot fit beside the live turn", () => {
		const msgs = convo();
		// Tiny window with realistic overhead: floor = 200 tokens, briefing alone is
		// ~200 — it cannot fit beside the live turn, so stale orientation is dropped.
		const plan = planFifo(msgs, 400, total(msgs) + 20, cfg);
		expect(plan.triggered).toBe(true);
		expect(plan.messages.some(isProtected)).toBe(false);
		expect(plan.messages.includes(msgs[msgs.length - 1])).toBe(true);
		// Bound: floor budget plus the F1 notice allowance. The notice may push
		// kept tokens past the bare floor; it may not push them arbitrarily far.
		expect(plan.keptMessageTokens).toBeLessThanOrEqual(cfg.contextFloor * 400 + 64);
	});

	it("no-ops on contextWindow=0", () => {
		const msgs = convo();
		expect(planFifo(msgs, 0, 99999, cfg).triggered).toBe(false);
	});

	it("never separates a toolResult from its assistant toolCall", () => {
		const call = (id: number) =>
			({
				role: "assistant",
				content: [
					{ type: "text", text: `calling ${id}` },
					{ type: "toolCall", id: `tc${id}`, name: "bash", arguments: { cmd: "x".repeat(200) } },
				],
				timestamp: 0,
			}) as Msg;
		const result = (id: number) =>
			({
				role: "toolResult",
				toolCallId: `tc${id}`,
				toolName: "bash",
				content: [{ type: "text", text: `out ${id} ${"O".repeat(600)}` }],
				isError: false,
				timestamp: 0,
			}) as Msg;
		const msgs: Msg[] = [briefing()];
		for (let i = 0; i < 12; i++) msgs.push(user(`U${i}`), call(i), result(i));

		// Sweep budgets so the cut lands at every possible unit boundary. Uses a
		// REALISTIC currentTokens (list total + small overhead): the old 99999 value
		// zeroed the budget at every window and tested a single scenario 58 times.
		const distinctKeptSizes = new Set<number>();
		for (let win = 120; win <= 2400; win += 40) {
			const plan = planFifo(msgs, win, total(msgs) + 60, cfg);
			distinctKeptSizes.add(plan.messages.length);
			for (const m of plan.messages) {
				if ((m as { role: string }).role !== "toolResult") continue;
				const id = (m as { toolCallId: string }).toolCallId;
				const kept = plan.messages.some(
					(k) =>
						(k as { role: string }).role === "assistant" &&
						((k as { content: Array<{ type: string; id?: string }> }).content ?? []).some(
							(b) => b.type === "toolCall" && b.id === id,
						),
				);
				expect(kept, `window=${win}: toolResult ${id} kept without its toolCall`).toBe(true);
			}
			// F1 invariant, same sweep: a triggered plan must never hand the provider a
			// window whose first message is assistant/toolResult (Anthropic 400).
			const first = plan.messages[0] as { role: string } | undefined;
			if (first) {
				expect(USER_CONVERTIBLE.has(first.role), `window=${win}: leading role ${first.role}`).toBe(true);
			}
		}
		// Prove the sweep exercised real boundaries, not one degenerate case.
		expect(distinctKeptSizes.size).toBeGreaterThan(2);
	});

	it("repairs an assistant-led window with a synthetic user-convertible notice (F1)", () => {
		// Pure agentic tail: user kickoff, then only assistant+toolResult pairs. Size
		// the window so the budget fits a bundle of trailing pairs but not the kickoff
		// user turn — the naive kept set would then START with an assistant message.
		const call = (id: number) =>
			({
				role: "assistant",
				content: [
					{ type: "text", text: `step ${id}` },
					{ type: "toolCall", id: `tc${id}`, name: "bash", arguments: { cmd: "x".repeat(160) } },
				],
				timestamp: 0,
			}) as Msg;
		const result = (id: number) =>
			({
				role: "toolResult",
				toolCallId: `tc${id}`,
				toolName: "bash",
				content: [{ type: "text", text: `out ${id} ${"O".repeat(400)}` }],
				isError: false,
				timestamp: 0,
			}) as Msg;
		const msgs: Msg[] = [user(`kickoff ${"K".repeat(1200)}`)];
		for (let i = 0; i < 10; i++) msgs.push(call(i), result(i));

		let repaired = 0;
		for (let win = 200; win <= 3000; win += 40) {
			const plan = planFifo(msgs, win, total(msgs) + 40, cfg);
			if (!plan.triggered) continue;
			const first = plan.messages[0] as { role: string; customType?: string };
			expect(USER_CONVERTIBLE.has(first.role), `window=${win}: leading role ${first.role}`).toBe(true);
			if (first.customType === FIFO_NOTICE_CUSTOM_TYPE) {
				repaired++;
				// The notice tells the model where the history went.
				const text = (plan.messages[0] as { content: Array<{ text?: string }> }).content?.[0]?.text ?? "";
				expect(text).toContain("rolled out of the context window");
				expect(text).toContain(String(plan.dropped));
				// The notice must not claim the briefing's protection slot.
				expect(isProtected(plan.messages[0])).toBe(false);
			}
		}
		// The scenario must actually exercise the repair path, not vacuously pass.
		expect(repaired).toBeGreaterThan(0);
	});
});

describe("planFifoFromUsage (trigger metric)", () => {
	const WINDOW = 4000;
	const OVERHEAD = 300; // system prompt + tool defs, invisible in `messages`

	/** Simulate pi: reported usage = provider count of what we last SENT + new messages since. */
	function reportedFor(sent: Msg[], since: Msg[]): number {
		return (
			OVERHEAD + sent.reduce((a, m) => a + estimateTokens(m), 0) + since.reduce((a, m) => a + estimateTokens(m), 0)
		);
	}

	it("learns the non-message overhead from the first report", () => {
		const msgs = convo();
		const state = newFifoTriggerState();
		planFifoFromUsage(msgs, WINDOW, reportedFor(msgs, []), cfg, state);
		const cal = deriveCalibration(state);
		expect(cal.offsetTokens).toBeCloseTo(OVERHEAD, 0);
		expect(cal.slope).toBe(1);
	});

	it("learns the estimator slope from two full-coverage reports (CJK/base64 undercount)", () => {
		// Provider counts 4x our estimate plus a fixed 300-token overhead.
		const state = newFifoTriggerState();
		const small = [user(`a ${"x".repeat(200)}`)];
		const smallEst = total(small);
		planFifoFromUsage(small, 100_000, 4 * smallEst + 300, cfg, state);
		const big = [...small, user(`b ${"y".repeat(4000)}`)];
		const bigEst = total(big);
		planFifoFromUsage(big, 100_000, 4 * bigEst + 300, cfg, state);
		const cal = deriveCalibration(state);
		expect(cal.slope).toBeCloseTo(4, 1);
		expect(cal.offsetTokens).toBeCloseTo(300, -1);
	});

	it("re-anchors: an atypical first sample stops skewing the slope once real samples exist", () => {
		// First report arrives BEFORE tool definitions load: offset is only 40.
		// From the second report on, the true regime is offset 800, slope 1.
		const state = newFifoTriggerState();
		const m1 = [user(`a ${"x".repeat(400)}`)];
		planFifoFromUsage(m1, 100_000, total(m1) + 40, cfg, state);
		const m2 = [...m1, user(`b ${"y".repeat(2000)}`)];
		planFifoFromUsage(m2, 100_000, total(m2) + 800, cfg, state);
		// Anchored on the atypical first sample, the secant is skewed upward here.
		const m3 = [...m2, user(`c ${"z".repeat(2400)}`)];
		planFifoFromUsage(m3, 100_000, total(m3) + 800, cfg, state);
		// The low anchor slid to sample 2; the secant 2→3 reflects the true regime.
		const cal = deriveCalibration(state);
		expect(cal.slope).toBeCloseTo(1, 1);
		expect(cal.offsetTokens).toBeCloseTo(800, -2);
	});

	it("resets calibration when the context window changes (model switch)", () => {
		const state = newFifoTriggerState();
		const msgs = [user(`a ${"x".repeat(400)}`)];
		planFifoFromUsage(msgs, 200_000, total(msgs) + 5_000, cfg, state);
		expect(deriveCalibration(state).offsetTokens).toBeGreaterThan(0);
		// Switch to a model with a different window: stale anchors must not carry.
		planFifoFromUsage(msgs, 32_000, null, cfg, state);
		expect(deriveCalibration(state).offsetTokens).toBe(0);
		expect(state.windowTokens).toBe(32_000);
	});

	it("prunes when provider usage exceeds the ceiling even if capped overhead leaves the estimate below it", () => {
		// Uses a conversation with content worth evicting. The original three-message
		// version asserted that an over-window report shreds a ~3-token conversation:
		// futile (dropping 3 tokens cannot fix a 1000-token overflow, which is
		// overhead FIFO cannot evict) and destructive. An over-window report is a
		// credible "over the limit" signal but not a credible measurement, so the
		// estimate is now the budget authority — real content still prunes, a tiny
		// conversation is left for ADR 0023 overflow recovery to handle.
		const messages = Array.from({ length: 12 }, (_, i) => user(`M${i} ${"x".repeat(400)}`));
		const plan = planFifoFromUsage(messages, 1000, 1100, cfg, newFifoTriggerState());
		expect(plan.triggered).toBe(true);
		expect(plan.dropped).toBeGreaterThan(0);
		expect(plan.messages).toContain(messages[messages.length - 1]);
	});

	it("still prunes on the call AFTER a prune, when reported usage reflects the pruned context", () => {
		// Grow a session past the ceiling.
		const msgs: Msg[] = [briefing()];
		for (let i = 0; i < 40; i++)
			msgs.push(i % 2 === 0 ? user(`U${i} ${"A".repeat(400)}`) : asst(`R${i} ${"A".repeat(400)}`));

		const state = newFifoTriggerState();
		// Call N: everything was sent last time, so the report covers the full list.
		const first = planFifoFromUsage(msgs, WINDOW, reportedFor(msgs, []), cfg, state);
		expect(first.triggered).toBe(true);

		// Call N+1: the session list is UNCHANGED (the hook is call-scoped) plus one new
		// turn, but pi now reports usage for the PRUNED context we actually sent.
		const grown = [...msgs, user("next question")];
		const staleReport = reportedFor(first.messages, [grown[grown.length - 1]]);
		expect(staleReport).toBeLessThan(cfg.contextCeiling * WINDOW); // the trap: looks fine

		const second = planFifoFromUsage(grown, WINDOW, staleReport, cfg, state);
		expect(second.triggered).toBe(true); // must NOT be fooled by the stale report
		expect(second.messages.length).toBeLessThan(grown.length);
	});

	it("a huge learned overhead cannot zero the message budget (floor-collision, F3)", () => {
		const msgs: Msg[] = [];
		for (let i = 0; i < 30; i++)
			msgs.push(i % 2 === 0 ? user(`U${i} ${"A".repeat(60)}`) : asst(`R${i} ${"A".repeat(60)}`));
		const state = newFifoTriggerState();
		// Estimator error taught a garbage-high OFFSET (anchors too close for a slope).
		state.sampleLowTokens = 300;
		state.sampleLowReported = 10_300;
		state.sampleHighTokens = 300;
		state.sampleHighReported = 10_300;
		const plan = planFifoFromUsage(msgs, 1000, null, cfg, state);
		expect(plan.triggered).toBe(true);
		// Old behavior: overhead capped at 0.5W == floor → budget 0 → only the newest
		// unit survives forever (single-turn amnesia). The floor-aware cap must leave
		// room for real history.
		expect(plan.messages.length).toBeGreaterThan(1);
	});

	it("the use-time cap never clobbers raw anchors within the same window (F3)", () => {
		const msgs = [user("hello")];
		const state = newFifoTriggerState();
		// Learned a 5,000-token offset on this window — far above the use-time cap.
		state.sampleLowTokens = 100;
		state.sampleLowReported = 5_100;
		state.sampleHighTokens = 100;
		state.sampleHighReported = 5_100;
		state.windowTokens = 1000;
		planFifoFromUsage(msgs, 1000, null, cfg, state); // capped at use, raw preserved
		expect(deriveCalibration(state).offsetTokens).toBe(5_000);
	});

	it("keeps the sent context under the ceiling across many turns", () => {
		const state = newFifoTriggerState();
		const session: Msg[] = [briefing()];
		let lastSent: Msg[] = [];
		for (let turn = 0; turn < 60; turn++) {
			session.push(user(`U${turn} ${"A".repeat(400)}`));
			const report = reportedFor(lastSent, session.slice(session.indexOf(lastSent[lastSent.length - 1]) + 1));
			const plan = planFifoFromUsage(session, WINDOW, Number.isFinite(report) ? report : null, cfg, state);
			lastSent = plan.triggered ? plan.messages : session.slice();
			const sentTokens = lastSent.reduce((a, m) => a + estimateTokens(m), 0) + OVERHEAD;
			expect(sentTokens, `turn ${turn}: sent context exceeded the window`).toBeLessThanOrEqual(WINDOW);
			session.push(asst(`R${turn} ${"A".repeat(400)}`));
		}
	});
});

describe("provider report normalization", () => {
	it("rejects values that cannot be interpreted at all", () => {
		for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
			expect(normalizeReportedTokens(bad as number | null), `input ${String(bad)}`).toBeNull();
		}
	});

	it("accepts plausible totals", () => {
		expect(normalizeReportedTokens(1)).toBe(1);
		expect(normalizeReportedTokens(750)).toBe(750);
	});

	it("KEEPS an over-window total: that is the provider reporting an over-limit request", () => {
		// Deliberately not rejected. fifo.ts documents that the uncapped report
		// triggers the current call when the provider says it is over the ceiling;
		// discarding it would idle FIFO exactly when pruning is required.
		expect(normalizeReportedTokens(999_999_999)).toBe(999_999_999);
	});
});

describe("invalid reports never drive pruning (R-01)", () => {
	const W = 1000;
	// Six small messages: comfortably under the 750-token ceiling.
	const under = () => Array.from({ length: 6 }, (_, i) => user(`M${i} short`));
	// Uninterpretable values only. An over-window total is valid (see below).
	const INVALID = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1] as const;

	it("an under-ceiling candidate is untouched by any invalid report", () => {
		const msgs = under();
		const baseline = planFifoFromUsage(msgs, W, null, cfg, newFifoTriggerState());
		expect(baseline.triggered).toBe(false);
		for (const bad of INVALID) {
			const plan = planFifoFromUsage(msgs, W, bad, cfg, newFifoTriggerState());
			expect(plan.triggered, `report=${String(bad)}`).toBe(false);
			expect(plan.dropped, `report=${String(bad)}`).toBe(0);
			expect(plan.messages.length, `report=${String(bad)}`).toBe(msgs.length);
		}
	});

	it("an over-ceiling candidate prunes identically with or without an invalid report", () => {
		const msgs = convo();
		const baseline = planFifoFromUsage(msgs, 900, null, cfg, newFifoTriggerState());
		expect(baseline.triggered).toBe(true);
		for (const bad of INVALID) {
			const plan = planFifoFromUsage(msgs, 900, bad, cfg, newFifoTriggerState());
			expect(plan.triggered, `report=${String(bad)}`).toBe(true);
			// Same budget, same cut — the invalid report changed nothing.
			expect(plan.dropped, `report=${String(bad)}`).toBe(baseline.dropped);
			expect(plan.keptMessageTokens, `report=${String(bad)}`).toBe(baseline.keptMessageTokens);
		}
	});

	it("a VALID over-ceiling report still drives pruning (the guard is not a mute button)", () => {
		const msgs = under();
		const plan = planFifoFromUsage(msgs, W, 900, cfg, newFifoTriggerState());
		expect(plan.triggered).toBe(true);
	});

	it("an over-window report prunes real content but is NOT stored as an anchor", () => {
		const state = newFifoTriggerState();
		const bulky = Array.from({ length: 12 }, (_, i) => user(`M${i} ${"x".repeat(400)}`));
		const plan = planFifoFromUsage(bulky, W, W * 10, cfg, state);
		expect(plan.triggered).toBe(true); // over the limit, and there is content to evict
		expect(state.sampleHighTokens).toBe(-1); // never learn a window-sized overhead
	});

	it("an over-window report does NOT shred an under-ceiling conversation (C2-01)", () => {
		// The reviewer's exact reproduction: six short messages, 1k window, absurd
		// report. Previously dropped 5 of 6. The report cannot be a measurement, so
		// it forces the trigger but our estimate decides the budget — and the estimate
		// says there is nothing worth evicting.
		const msgs = under();
		for (const absurd of [999_999_999, Number.MAX_SAFE_INTEGER, W + 1, 1e12]) {
			const plan = planFifoFromUsage(msgs, W, absurd, cfg, newFifoTriggerState());
			expect(plan.dropped, `report=${absurd}`).toBe(0);
			expect(plan.messages.length, `report=${absurd}`).toBe(msgs.length);
		}
	});

	it("an over-window report still prunes when there IS content to evict", () => {
		const bulky = Array.from({ length: 40 }, (_, i) => user(`M${i} ${"x".repeat(400)}`));
		const baseline = planFifoFromUsage(bulky, W, null, cfg, newFifoTriggerState());
		for (const absurd of [W + 100, 999_999_999]) {
			const plan = planFifoFromUsage(bulky, W, absurd, cfg, newFifoTriggerState());
			expect(plan.triggered, `report=${absurd}`).toBe(true);
			// Identical to the estimate-only baseline: the magnitude buys no extra damage.
			expect(plan.dropped, `report=${absurd}`).toBe(baseline.dropped);
		}
	});

	it("no uninterpretable report is ever stored as a calibration anchor", () => {
		for (const bad of INVALID) {
			const state = newFifoTriggerState();
			planFifoFromUsage(under(), W, bad, cfg, state);
			expect(state.sampleHighTokens, `report=${String(bad)}`).toBe(-1);
			expect(deriveCalibration(state).offsetTokens, `report=${String(bad)}`).toBe(0);
		}
	});

	it("always returns a well-formed FifoPlan whatever the report", () => {
		for (const bad of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 999_999_999]) {
			const plan = planFifoFromUsage(under(), W, bad as number | null, cfg, newFifoTriggerState());
			expect(plan, `report=${String(bad)}`).toBeDefined();
			expect(typeof plan.triggered).toBe("boolean");
			expect(Array.isArray(plan.messages)).toBe(true);
		}
	});
});

describe("hostile provider reports (R-01 adversarial)", () => {
	const hostile = [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		0,
		-1,
		-99999,
		Number.MAX_SAFE_INTEGER,
		Number.MIN_SAFE_INTEGER,
		1e308,
		-1e308,
		0.5,
		-0.0,
	];

	it("no hostile report ever produces a non-finite budget or a NaN token count", () => {
		const msgs = Array.from({ length: 8 }, (_, i) => user(`M${i} ${"x".repeat(200)}`));
		for (const r of hostile) {
			for (const W of [0, 1, 1000, 1_048_576]) {
				const plan = planFifoFromUsage(msgs, W, r, cfg, newFifoTriggerState());
				expect(Number.isFinite(plan.keptMessageTokens), `r=${r} W=${W}`).toBe(true);
				expect(Number.isFinite(plan.dropped), `r=${r} W=${W}`).toBe(true);
				expect(plan.dropped, `r=${r} W=${W}`).toBeGreaterThanOrEqual(0);
				expect(plan.messages.length, `r=${r} W=${W}`).toBeGreaterThan(0);
			}
		}
	});

	it("hostile reports never differ from the null baseline", () => {
		const msgs = Array.from({ length: 8 }, (_, i) => user(`M${i} ${"x".repeat(200)}`));
		for (const W of [1000, 100_000]) {
			const base = planFifoFromUsage(msgs, W, null, cfg, newFifoTriggerState());
			for (const r of hostile.filter((x) => !Number.isFinite(x) || x <= 0)) {
				const plan = planFifoFromUsage(msgs, W, r, cfg, newFifoTriggerState());
				expect(plan.triggered, `r=${r} W=${W}`).toBe(base.triggered);
				expect(plan.dropped, `r=${r} W=${W}`).toBe(base.dropped);
			}
		}
	});

	it("state is never corrupted by a hostile report", () => {
		for (const r of hostile) {
			const st = newFifoTriggerState();
			planFifoFromUsage([user("a")], 1000, r, cfg, st);
			for (const [k, v] of Object.entries(st)) {
				if (typeof v === "number") expect(Number.isFinite(v), `${k} after r=${r}`).toBe(true);
			}
		}
	});

	it("normalization is pure and total", () => {
		for (const r of [...hostile, null, undefined, "500" as unknown as number, {} as unknown as number]) {
			const out = normalizeReportedTokens(r as number | null);
			expect(out === null || (typeof out === "number" && Number.isFinite(out) && out > 0), `r=${String(r)}`).toBe(
				true,
			);
		}
	});

	it("a genuine over-limit report prunes when there is content to evict", () => {
		// Enough content that eviction is meaningful at both window sizes. With a
		// near-empty candidate there is nothing FIFO can usefully drop, and forcing
		// it to would destroy history without relieving the overflow.
		const msgs = Array.from({ length: 60 }, (_, i) => user(`M${i} ${"x".repeat(400)}`));
		for (const W of [1000, 10_000]) {
			const plan = planFifoFromUsage(msgs, W, W * 2, cfg, newFifoTriggerState());
			expect(plan.triggered, `W=${W}`).toBe(true);
		}
	});
});
