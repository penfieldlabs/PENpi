/**
 * Property-based tests for the FIFO planner.
 *
 * The unit tests pin specific scenarios; these sweep thousands of RANDOMIZED
 * conversations (seeded PRNG — fully deterministic in CI) and assert the
 * invariants that must hold for EVERY plan:
 *
 *   P1  No orphaned toolResult: every kept toolResult's toolCall is kept.
 *   P2  Leading role is user-convertible on every triggered plan (Anthropic's
 *       API validation rejects an assistant-led conversation with HTTP 400).
 *   P3  Original order is preserved; the newest live message is always kept.
 *   P4  The synthetic FIFO notice appears at most once, only as the first
 *       message, only on triggered plans, and never claims briefing protection.
 *   P5  Multi-turn: simulated sent context (messages + overhead) never exceeds
 *       the window across long sessions, including estimator-hostile content
 *       (provider reports ~4x our chars/4 estimate, as with CJK/base64), and
 *       learned overhead never collapses the window to a single unit
 *       (single-turn amnesia) when the floor leaves room.
 */
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FIFO_NOTICE_CUSTOM_TYPE, isProtected, newFifoTriggerState, planFifo, planFifoFromUsage } from "./fifo.ts";

type Msg = Parameters<typeof planFifo>[0][number];

const USER_CONVERTIBLE = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);

/** Deterministic PRNG (mulberry32) so failures reproduce from the logged seed. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomConversation(rand: () => number): Msg[] {
	const msgs: Msg[] = [];
	if (rand() < 0.5) {
		msgs.push({
			role: "custom",
			customType: "penpi-briefing",
			content: "B".repeat(80 + Math.floor(rand() * 1600)),
			display: false,
			timestamp: 0,
		} as Msg);
	}
	const turns = 2 + Math.floor(rand() * 28);
	let toolId = 0;
	for (let t = 0; t < turns; t++) {
		const kind = rand();
		if (kind < 0.35) {
			msgs.push({
				role: "user",
				content: [{ type: "text", text: `U${t} ${"u".repeat(Math.floor(rand() * 600))}` }],
				timestamp: t,
			} as Msg);
		} else if (kind < 0.55) {
			msgs.push({
				role: "assistant",
				content: [{ type: "text", text: `A${t} ${"a".repeat(Math.floor(rand() * 600))}` }],
				timestamp: t,
			} as Msg);
		} else {
			// Assistant with 1-3 tool calls followed by its results (multi-result unit).
			const calls = 1 + Math.floor(rand() * 3);
			const ids = Array.from({ length: calls }, () => `tc${toolId++}`);
			msgs.push({
				role: "assistant",
				content: [
					{ type: "text", text: `C${t}` },
					...ids.map((id) => ({
						type: "toolCall",
						id,
						name: "bash",
						arguments: { cmd: "x".repeat(Math.floor(rand() * 300)) },
					})),
				],
				timestamp: t,
			} as Msg);
			for (const id of ids) {
				msgs.push({
					role: "toolResult",
					toolCallId: id,
					toolName: "bash",
					content: [{ type: "text", text: `out ${"o".repeat(Math.floor(rand() * 900))}` }],
					isError: false,
					timestamp: t,
				} as Msg);
			}
		}
	}
	return msgs;
}

const cfgs = [
	{ contextCeiling: 0.75, contextFloor: 0.5 },
	{ contextCeiling: 0.9, contextFloor: 0.7 },
	{ contextCeiling: 0.6, contextFloor: 0.3 },
];

/** Estimated tokens of the trailing atomic unit (assistant + its toolResults, or the single last message). */
function liveUnitTokens(msgs: Msg[]): number {
	let i = msgs.length - 1;
	let sum = 0;
	if ((msgs[i] as { role: string }).role === "toolResult") {
		while (i >= 0 && (msgs[i] as { role: string }).role === "toolResult") {
			sum += estimateTokens(msgs[i]);
			i--;
		}
		if (i >= 0 && (msgs[i] as { role: string }).role === "assistant") sum += estimateTokens(msgs[i]);
	} else {
		sum = estimateTokens(msgs[i]);
	}
	return sum;
}

describe("planFifo properties (randomized, seeded)", () => {
	it("P1-P4 hold across 4,000 randomized conversations x windows", () => {
		for (let seed = 1; seed <= 4000; seed++) {
			const rand = rng(seed);
			const msgs = randomConversation(rand);
			const total = msgs.reduce((a, m) => a + estimateTokens(m), 0);
			const cfg = cfgs[seed % cfgs.length];
			const overhead = Math.floor(rand() * 200);
			const window = 100 + Math.floor(rand() * Math.max(1, total * 1.5));
			const plan = planFifo(msgs, window, total + overhead, cfg);
			const tag = `seed=${seed} window=${window} cfg=${JSON.stringify(cfg)}`;

			// P3: order + newest message kept.
			const idxs = plan.messages.map((m) => msgs.indexOf(m)).filter((i) => i >= 0);
			expect(idxs, tag).toEqual([...idxs].sort((a, b) => a - b));
			expect(plan.messages.includes(msgs[msgs.length - 1]), `${tag}: newest dropped`).toBe(true);

			// P1: no orphaned toolResult.
			for (const m of plan.messages) {
				if ((m as { role: string }).role !== "toolResult") continue;
				const id = (m as { toolCallId: string }).toolCallId;
				const callKept = plan.messages.some(
					(k) =>
						(k as { role: string }).role === "assistant" &&
						((k as { content?: Array<{ type: string; id?: string }> }).content ?? []).some(
							(b) => b.type === "toolCall" && b.id === id,
						),
				);
				expect(callKept, `${tag}: orphaned toolResult ${id}`).toBe(true);
			}

			// P2: leading role must be user-convertible on triggered plans.
			if (plan.triggered && plan.messages.length > 0) {
				const first = plan.messages[0] as { role: string };
				expect(USER_CONVERTIBLE.has(first.role), `${tag}: leading role ${first.role}`).toBe(true);
			}

			// P4: notice discipline.
			const notices = plan.messages.filter(
				(m) => (m as { customType?: string }).customType === FIFO_NOTICE_CUSTOM_TYPE,
			);
			expect(notices.length, `${tag}: multiple notices`).toBeLessThanOrEqual(1);
			if (notices.length === 1) {
				expect(plan.triggered, `${tag}: notice on untriggered plan`).toBe(true);
				expect(plan.messages[0], `${tag}: notice not first`).toBe(notices[0]);
				expect(isProtected(notices[0]), `${tag}: notice claims protection`).toBe(false);
			}

			// P6: kept tokens are bounded. The floor budget governs, except the live
			// unit is kept unconditionally (never send an empty turn) and the F1
			// notice may add up to ~64 tokens on top of either.
			if (plan.triggered) {
				const bound = Math.max(cfg.contextFloor * window, liveUnitTokens(msgs)) + 64;
				expect(
					plan.keptMessageTokens,
					`${tag}: kept ${plan.keptMessageTokens} > bound ${bound}`,
				).toBeLessThanOrEqual(bound);
			}
		}
	}, 30_000);

	it("P5: long sessions stay under the window, including estimator-hostile content", () => {
		for (const hostile of [false, true]) {
			for (let seed = 1; seed <= 40; seed++) {
				const rand = rng(seed * 7919);
				const WINDOW = 2000 + Math.floor(rand() * 6000);
				const OVERHEAD = 100 + Math.floor(rand() * 400);
				const cfg = cfgs[seed % cfgs.length];
				const state = newFifoTriggerState();
				const session: Msg[] = [];
				let lastSent: Msg[] = [];
				// Provider counts tokens ~4x our estimate for hostile content (CJK/base64).
				const providerTokens = (m: Msg[]) => m.reduce((a, x) => a + estimateTokens(x) * (hostile ? 4 : 1), 0);
				for (let turn = 0; turn < 80; turn++) {
					session.push({
						role: "user",
						content: [{ type: "text", text: `U${turn} ${"м".repeat(120 + Math.floor(rand() * 300))}` }],
						timestamp: turn,
					} as Msg);
					const sinceIdx = lastSent.length ? session.indexOf(lastSent[lastSent.length - 1]) + 1 : 0;
					const report = OVERHEAD + providerTokens(lastSent) + providerTokens(session.slice(sinceIdx));
					const plan = planFifoFromUsage(session, WINDOW, report, cfg, state);
					lastSent = plan.triggered ? plan.messages : session.slice();
					const tag = `hostile=${hostile} seed=${seed} turn=${turn} window=${WINDOW}`;
					// The REAL token count of what we send must respect the window — the
					// calibration ratio makes eviction converge on the floor even when the
					// estimator undercounts 4x.
					const sentReal = providerTokens(lastSent) + OVERHEAD;
					expect(sentReal, `${tag}: sent over window (real tokens)`).toBeLessThanOrEqual(WINDOW);
					// No single-turn amnesia on the calibrated path: once the session is
					// deep, pruning must retain more than the live unit alone. (Not asserted
					// in hostile mode: with a genuine 4x undercount the provider-confirmed
					// capacity for messages is honestly tiny, and keeping only the live unit
					// can be the correct answer for large messages.)
					if (!hostile && plan.triggered && turn > 20) {
						expect(plan.messages.length, `${tag}: single-turn amnesia`).toBeGreaterThan(1);
					}
					session.push({
						role: "assistant",
						content: [{ type: "text", text: `A${turn} ${"д".repeat(120 + Math.floor(rand() * 300))}` }],
						timestamp: turn,
					} as Msg);
				}
			}
		}
	}, 30_000);
});
