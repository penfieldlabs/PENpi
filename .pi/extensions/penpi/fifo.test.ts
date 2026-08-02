import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isProtected, newFifoTriggerState, planFifo, planFifoFromUsage } from "./fifo.ts";

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

	it("preserves original order", () => {
		const msgs = convo();
		const plan = planFifo(msgs, 1000, 99999, cfg);
		const idxs = plan.messages.map((m) => msgs.indexOf(m));
		expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
	});

	it("drops the briefing rather than overflowing a tiny model window", () => {
		const msgs = convo();
		const plan = planFifo(msgs, 400, 99999, cfg);
		expect(plan.triggered).toBe(true);
		expect(plan.messages.some(isProtected)).toBe(false);
		expect(plan.messages.includes(msgs[msgs.length - 1])).toBe(true);
		expect(plan.keptMessageTokens).toBeLessThanOrEqual(cfg.contextFloor * 400);
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

		// Sweep budgets so the naive cut would land at every possible boundary.
		for (let win = 120; win <= 2400; win += 40) {
			const plan = planFifo(msgs, win, 99999, cfg);
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
		}
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
		expect(state.overheadTokens).toBeCloseTo(OVERHEAD, 0);
	});

	it("prunes when provider usage exceeds the ceiling even if capped overhead leaves the estimate below it", () => {
		const messages = [user("oldest"), asst("older"), user("current")];
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
