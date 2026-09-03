/**
 * FIFO context management (watermarks).
 *
 * The `context` hook fires before every LLM call. When context usage crosses
 * the ceiling, we drop the OLDEST conversation messages until usage is back at
 * the floor — creating a sawtooth between floor and ceiling rather than riding
 * at ~100% (which costs more and degrades many models).
 *
 * Dropped messages are NOT lost: they remain verbatim in Pi's session JSONL
 * (Tier 3) and anything important should already be in Penfield (Tier 2).
 *
 * This planner is PURE and deterministic so it can be unit-tested without a
 * live session. Per the build plan: get the mechanic right, benchmark later;
 * keep the door open for smarter strategies (drop tool results first, etc.).
 */
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { PenpiConfig } from "./config.ts";

/** Pi's conversation message type, derived from estimateTokens (not re-exported by name). */
type AgentMessage = Parameters<typeof estimateTokens>[0];

export interface FifoPlan {
	/** Whether the ceiling was crossed and pruning happened. */
	triggered: boolean;
	/** The messages to keep (original order). Same array reference when not triggered. */
	messages: AgentMessage[];
	/** Number of messages dropped. */
	dropped: number;
	/** Estimated tokens of the kept messages (excludes non-message overhead). 0 when not triggered. */
	keptMessageTokens: number;
}

/**
 * Tracks what pi's usage report can't tell us. See planFifoFromUsage.
 *
 * The provider's true usage for a full-coverage report is (to first order)
 * `reported ≈ slope * messageEstimate + offset`, where `offset` is the fixed
 * non-message overhead (system prompt + tool defs) and `slope >= 1` is the
 * estimator calibration — chars/4 undercounts CJK, base64, and minified
 * content by up to ~4x, an error that SCALES with the messages and therefore
 * cannot be modelled as offset. One sample cannot split the two, so the state
 * keeps TWO full-coverage anchors (lowest and highest accepted sample) and
 * derives slope/offset by regression. Post-prune reports go stale (they cover
 * the pruned context, not the candidate list) and are rejected by the
 * monotone-growth acceptance rule, so they cannot corrupt the anchors.
 *
 * Values are stored RAW; window-dependent clamping happens at use time, so
 * visiting a small-context model never destroys what was learned.
 */
export interface FifoTriggerState {
	/** Message-estimate tokens of the low/high accepted full-coverage samples (-1 = none). */
	sampleLowTokens: number;
	sampleLowReported: number;
	sampleHighTokens: number;
	sampleHighReported: number;
	/** Context window the anchors were learned on (-1 = none). A window change
	 * resets calibration: it signals a model switch, and calibration is
	 * tokenizer- and system-prompt-specific. */
	windowTokens: number;
}

export function newFifoTriggerState(): FifoTriggerState {
	return {
		sampleLowTokens: -1,
		sampleLowReported: 0,
		sampleHighTokens: -1,
		sampleHighReported: 0,
		windowTokens: -1,
	};
}

/** Upper bound for learned calibration slope — 8x covers every realistic tokenizer mismatch. */
const MAX_CALIBRATION = 8;

/** Minimum anchor separation (in estimate tokens) before we trust a regression slope. */
const MIN_SLOPE_BASELINE = 64;

/** Derived calibration: `reported ≈ slope * estimate + offsetTokens`. Exported for tests/debug. */
export function deriveCalibration(state: FifoTriggerState): { slope: number; offsetTokens: number } {
	if (state.sampleHighTokens < 0) return { slope: 1, offsetTokens: 0 };
	let slope = 1;
	const dm = state.sampleHighTokens - state.sampleLowTokens;
	if (dm >= MIN_SLOPE_BASELINE) {
		const dr = state.sampleHighReported - state.sampleLowReported;
		slope = Math.min(Math.max(dr / dm, 1), MAX_CALIBRATION);
	}
	const offsetTokens = Math.max(0, state.sampleHighReported - slope * state.sampleHighTokens);
	return { slope, offsetTokens };
}

/**
 * Normalize a provider's reported context total to a value we are willing to act
 * on, or `null` to fall back entirely to our own candidate-list estimate.
 *
 * Rejects only what cannot be interpreted at all: non-numeric, non-finite
 * (`NaN`/`Infinity`) and non-positive. Those are broken providers, and feeding
 * them onward poisons every arithmetic path downstream — `Math.max(estimate,
 * NaN)` is `NaN`, which makes the budget `NaN`, which prunes the window down to
 * its newest message on a candidate that was never over the ceiling.
 *
 * Deliberately does NOT reject a total larger than the context window. That is
 * not garbage — it is the provider saying the request is over the limit, which
 * is the single strongest reason to prune. Discarding it would idle FIFO exactly
 * when it is needed. See the trigger contract above and the over-ceiling test.
 *
 * Exported so the normalization is testable directly, not only through a plan.
 */
export function normalizeReportedTokens(reported: number | null | undefined): number | null {
	if (reported == null || typeof reported !== "number") return null;
	if (!Number.isFinite(reported) || reported <= 0) return null;
	return reported;
}

/**
 * Whether a normalized report may additionally be LEARNED FROM as a calibration
 * anchor. Stricter than the trigger: a total above the context window is a valid
 * "you are over the limit" signal for this call, but storing it as an anchor
 * would teach a permanent overhead the window cannot actually hold.
 */
function isAnchorableReport(usable: number, contextWindow: number): boolean {
	return contextWindow <= 0 || usable <= contextWindow;
}

/** Never let a learned overhead starve the message budget entirely. */
const MAX_OVERHEAD_FRACTION = 0.5;

/**
 * Fraction of the floor that learned overhead may consume at most. Guarantees
 * the message budget keeps at least (1 - MAX_OVERHEAD_FLOOR_FRACTION) of the
 * floor when the ESTIMATE path triggers. Without this, a learned overhead
 * capped at MAX_OVERHEAD_FRACTION (0.5) collides with the default floor (0.5):
 * budget = 0.5W - 0.5W = 0 and every prune keeps only the newest unit —
 * single-turn amnesia that never recovers, reachable when the chars/4 token
 * heuristic badly underestimates (CJK text, base64, minified code). A genuine
 * provider-REPORTED overflow is unaffected: planFifo derives real overhead
 * from currentTokens when the report wins the trigger race.
 */
const MAX_OVERHEAD_FLOOR_FRACTION = 0.8;

/** customType of the synthetic notice injected when role repair is needed (see planFifo). */
export const FIFO_NOTICE_CUSTOM_TYPE = "penpi-fifo-notice";

/**
 * Message roles that convertToLlm maps to a `user`-role LLM message. A pruned
 * window must START with one of these: Anthropic's Messages API validation
 * rejects a conversation whose first message is `assistant` (HTTP 400
 * invalid_request_error), as do strict Anthropic-format endpoints; pi sends the
 * hook's returned array verbatim with no leading-role repair downstream.
 * (OpenAI-compatible APIs tolerate assistant-led lists, and Gemini's current
 * API was observed accepting model-led contents in Aug 2026 — the repair keeps
 * the window valid for the strictest provider it may be sent to.)
 */
const USER_CONVERTIBLE_ROLES = new Set(["user", "custom", "bashExecution", "branchSummary", "compactionSummary"]);

/**
 * Decide a FIFO plan from pi's *reported* context usage.
 *
 * Why this wrapper exists: the `context` hook is call-scoped — the messages we
 * return are used for THIS LLM call only; the session's own message list is never
 * mutated (the runner even hands us a structuredClone). Meanwhile pi's
 * `getContextUsage()` is derived from the last assistant's provider-reported usage
 * plus the messages after it — i.e. it reflects the PRUNED context we last sent,
 * not the full list we are handed now.
 *
 * Triggering directly on that number makes FIFO fire on alternate calls only:
 * prune to floor → provider reports ~floor → next call reads ~floor, doesn't
 * trigger, and sends the full (still-growing) history verbatim. With compaction
 * disabled in the fork, that ends in an unrecoverable provider overflow.
 *
 * So we trigger on the greater of our own candidate-list estimate and the
 * provider-reported usage. The report also teaches us the non-message overhead
 * (system prompt + tool defs), which we can't see in `messages`. Learned overhead
 * is capped so it cannot permanently starve later calls; the uncapped report still
 * triggers the current call when the provider says it is over the ceiling.
 */
export function planFifoFromUsage(
	messages: AgentMessage[],
	contextWindow: number,
	reportedTokens: number | null | undefined,
	cfg: Pick<PenpiConfig, "contextCeiling" | "contextFloor">,
	state: FifoTriggerState,
): FifoPlan {
	const messageTokens = messages.reduce((a, m) => a + estimateTokens(m), 0);

	// A context-window change signals a model switch; calibration is tokenizer-
	// and system-prompt-specific, so stale anchors must not carry over (they
	// would over-prune forever — anchors are otherwise monotone by design).
	// Same-window model swaps are the residual blind spot: their stale offset
	// persists, bounded by the floor-aware cap, until the session ends.
	if (contextWindow > 0 && state.windowTokens > 0 && state.windowTokens !== contextWindow) {
		const fresh = newFifoTriggerState();
		state.sampleLowTokens = fresh.sampleLowTokens;
		state.sampleLowReported = fresh.sampleLowReported;
		state.sampleHighTokens = fresh.sampleHighTokens;
		state.sampleHighReported = fresh.sampleHighReported;
	}
	if (contextWindow > 0) state.windowTokens = contextWindow;

	// Anchor acceptance: a sample can only be a full-coverage report if it grew
	// past the highest accepted report (a genuine session only accumulates
	// tokens between calls). Post-prune reports cover the PRUNED context — they
	// shrink, fail the monotone rule, and are rejected, so learning is immune
	// to the stale-report trap by construction.
	//
	// The low anchor SLIDES: once the current anchor pair is far enough apart to
	// yield a trusted slope (MIN_SLOPE_BASELINE), an accepted sample promotes the
	// old high to the new low. The regression is therefore always the most
	// recent well-separated secant, so an atypical first sample (taken before
	// tool definitions loaded, or on an unusually small turn) skews the slope
	// only until two representative samples exist, not for the whole session.
	//
	// ONE normalization, then two policies layered on it:
	//   - uninterpretable values (non-finite, non-positive) are refused outright,
	//     for both learning and pruning;
	//   - an over-window value is refused for LEARNING (it would teach an overhead
	//     the window cannot hold) but retained as a pruning signal, bounded to the
	//     window. See the trigger block below.
	const usableReport = normalizeReportedTokens(reportedTokens);
	if (usableReport != null && usableReport > messageTokens && isAnchorableReport(usableReport, contextWindow)) {
		if (state.sampleHighTokens < 0) {
			state.sampleLowTokens = messageTokens;
			state.sampleLowReported = usableReport;
			state.sampleHighTokens = messageTokens;
			state.sampleHighReported = usableReport;
		} else if (usableReport >= state.sampleHighReported) {
			if (messageTokens > state.sampleHighTokens) {
				if (state.sampleHighTokens - state.sampleLowTokens >= MIN_SLOPE_BASELINE) {
					state.sampleLowTokens = state.sampleHighTokens;
					state.sampleLowReported = state.sampleHighReported;
				}
				state.sampleHighTokens = messageTokens;
				state.sampleHighReported = usableReport;
			} else if (messageTokens === state.sampleHighTokens) {
				state.sampleHighReported = usableReport;
			}
		}
	}

	const { slope, offsetTokens } = deriveCalibration(state);
	// Clamp the OFFSET at use time only (state keeps raw anchors — see
	// FifoTriggerState). The cap is floor-aware so a learned offset can never
	// zero the message budget in planFifo.
	const overheadCap =
		contextWindow > 0
			? Math.min(MAX_OVERHEAD_FRACTION, cfg.contextFloor * MAX_OVERHEAD_FLOOR_FRACTION) * contextWindow
			: Number.POSITIVE_INFINITY;
	const cappedOffset = Math.min(offsetTokens, overheadCap);
	const estimatedTokens = messageTokens * slope + cappedOffset;
	// Trigger identity and budget authority are separate concerns.
	//
	// A report at or below the window is a credible measurement: it may legitimately
	// exceed our estimate because of fixed overhead (system prompt, tool defs) that
	// `messages` cannot show us, so we trigger on the greater of the two and let the
	// gap teach calibration.
	//
	// A report ABOVE the window cannot be a measurement — nothing fits in more than
	// the window. It is still meaningful: the provider is saying this request is over
	// the limit, and ignoring that would idle FIFO exactly when it is needed. But its
	// MAGNITUDE is not evidence of anything. Feeding it to planFifo drove the overhead
	// and ratio arithmetic to an effectively zero budget, collapsing a six-message
	// conversation to one message on a 1k window — identical damage whether the report
	// was 1_100 or 999_999_999.
	//
	// So: over-window reports force the trigger, and our own estimate remains the
	// budget authority. An over-limit session with real content still prunes to the
	// floor; a tiny conversation with an absurd report is left intact, because the
	// estimate says there is nothing to evict.
	const overWindow = usableReport != null && contextWindow > 0 && usableReport > contextWindow;
	const credibleReport = overWindow ? null : usableReport;
	const triggerTokens = credibleReport == null ? estimatedTokens : Math.max(estimatedTokens, credibleReport);
	return planFifo(messages, contextWindow, triggerTokens, cfg, { forceTrigger: overWindow });
}

/** PENpi's own injected messages (any generation). The call-scoped FIFO notice is
 * excluded: it is synthetic, never persisted, and must not claim the protection
 * slot reserved for the newest orientation briefing. */
function isPenpiMessage(m: AgentMessage): boolean {
	return (
		m.role === "custom" &&
		typeof m.customType === "string" &&
		m.customType.startsWith("penpi-") &&
		m.customType !== FIFO_NOTICE_CUSTOM_TYPE
	);
}

/** PENpi's own injected messages are protected from FIFO eviction. */
export function isProtected(m: AgentMessage): boolean {
	return isPenpiMessage(m);
}

/**
 * Which indices are protected for THIS plan.
 *
 * Only the most recent orientation briefing is protected. A resumed session
 * re-runs session_start and injects a fresh briefing, and those messages are
 * persisted — so without this, N resumes would pin N briefings (N-1 of them
 * stale, with contradictory "recent" reflections) in the window forever.
 */
function protectedIndices(messages: AgentMessage[]): boolean[] {
	const flags = new Array<boolean>(messages.length).fill(false);
	let newestPenpi = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isPenpiMessage(messages[i])) {
			newestPenpi = i;
			break;
		}
	}
	if (newestPenpi >= 0) flags[newestPenpi] = true;
	return flags;
}

/**
 * Decide which messages to keep.
 *
 * @param messages       Full conversation message array (no system prompt).
 * @param contextWindow  Model context window in tokens.
 * @param currentTokens  Current total context usage (incl. system prompt + tool defs).
 * @param cfg            ceiling/floor fractions.
 */
export function planFifo(
	messages: AgentMessage[],
	contextWindow: number,
	currentTokens: number,
	cfg: Pick<PenpiConfig, "contextCeiling" | "contextFloor">,
	/**
	 * Force the ceiling test to pass while leaving `currentTokens` as the budget
	 * authority. Used when a provider reports a total above the context window:
	 * that is a credible "you are over the limit" signal but NOT a credible
	 * measurement, so it must not be allowed to drive the eviction budget.
	 */
	opts?: { forceTrigger?: boolean },
): FifoPlan {
	const ceilingTokens = cfg.contextCeiling * contextWindow;
	if (!contextWindow || (currentTokens <= ceilingTokens && !opts?.forceTrigger)) {
		return { triggered: false, messages, dropped: 0, keptMessageTokens: 0 };
	}

	const perMessage = messages.map(estimateTokens);
	const totalMessageTokens = perMessage.reduce((a, b) => a + b, 0);
	// Split (currentTokens - message estimate) into two different things:
	//   fixedOverhead — non-message overhead (system prompt, tool defs) we cannot
	//     evict, bounded by the floor-aware cap so it can never zero the budget;
	//   excess — anything beyond that cap. A gap that large is not plausible fixed
	//     overhead; it is the chars/4 estimator undercounting the MESSAGES (CJK,
	//     base64, minified code). That part scales WITH the messages, so treating
	//     it as unevictable would prune everything (single-turn amnesia). Model it
	//     as a calibration ratio instead: each estimated token is really worth
	//     ~ratio tokens, so the estimated-token budget shrinks by /ratio and
	//     eviction converges on the floor instead of on zero.
	const overheadRaw = Math.max(0, currentTokens - totalMessageTokens);
	const overheadCap = Math.min(MAX_OVERHEAD_FRACTION, cfg.contextFloor * MAX_OVERHEAD_FLOOR_FRACTION) * contextWindow;
	const fixedOverhead = Math.min(overheadRaw, overheadCap);
	const excess = overheadRaw - fixedOverhead;
	const ratio = totalMessageTokens > 0 ? (totalMessageTokens + excess) / totalMessageTokens : 1;
	const floorTokens = cfg.contextFloor * contextWindow;
	const messageBudget = Math.max(0, (floorTokens - fixedOverhead) / ratio);

	// Find the newest briefing, but do not let it force an otherwise avoidable
	// overflow on a small-context model. The newest live turn takes priority.
	const isKept = protectedIndices(messages);
	const keep = new Array<boolean>(messages.length).fill(false);
	let used = 0;

	// Group non-protected messages into atomic units: an assistant message plus its
	// trailing toolResult messages drop or stay together. A cut inside the pair would
	// leave a toolResult whose toolCall is gone — pi synthesizes results for orphaned
	// calls, but an orphaned RESULT is sent as-is and rejected by provider APIs.
	const units: number[][] = [];
	for (let i = 0; i < messages.length; i++) {
		if (isKept[i]) continue;
		const unit = [i];
		if (messages[i].role === "assistant") {
			let j = i + 1;
			while (j < messages.length && (isKept[j] || messages[j].role === "toolResult")) {
				if (!isKept[j]) unit.push(j);
				j++;
			}
			i = j - 1;
		}
		units.push(unit);
	}

	// Keep the most recent atomic unit first so we never send an empty live turn.
	let keptAny = false;
	let nextUnit = units.length - 1;
	if (nextUnit >= 0) {
		const unit = units[nextUnit--];
		for (const idx of unit) keep[idx] = true;
		used = unit.reduce((a, idx) => a + perMessage[idx], 0);
		keptAny = true;
	}

	// Keep the newest briefing when it fits beside the live turn. If it cannot,
	// dropping stale orientation is safer than knowingly exceeding the window.
	for (let i = 0; i < messages.length; i++) {
		if (!isKept[i]) continue;
		if (used + perMessage[i] <= messageBudget || !keptAny) {
			keep[i] = true;
			used += perMessage[i];
			keptAny = true;
		}
	}

	// Walk the remaining units newest -> oldest, keeping recent history within budget.
	for (let u = nextUnit; u >= 0; u--) {
		const unit = units[u];
		const next = used + unit.reduce((a, idx) => a + perMessage[idx], 0);
		if (next <= messageBudget) {
			for (const idx of unit) keep[idx] = true;
			used = next;
		} else {
			break; // every unit older than here is dropped
		}
	}

	const kept = messages.filter((_, i) => keep[i]);
	const dropped = messages.length - kept.length;
	if (dropped === 0) {
		return { triggered: false, messages, dropped: 0, keptMessageTokens: 0 };
	}

	// Leading-role repair: the suffix walk keeps whole units, and a unit can start
	// with an assistant message (assistant + trailing toolResults). Anthropic's
	// validation rejects a request whose first message is `assistant` with HTTP
	// 400, and nothing downstream repairs the leading role. Prepending a small synthetic
	// user-convertible notice fixes the role without sacrificing kept history (a
	// few dozen tokens live comfortably inside ceiling-vs-window headroom). The
	// notice exists only in this call-scoped return value — it is never persisted
	// to the session, so the next plan recomputes from the untouched full list.
	const first = kept[0];
	if (first !== undefined && !USER_CONVERTIBLE_ROLES.has(first.role)) {
		const notice = makeFifoNotice(dropped, (first as { timestamp?: number }).timestamp ?? 0);
		kept.unshift(notice);
		used += estimateTokens(notice);
	}

	return { triggered: true, messages: kept, dropped, keptMessageTokens: used };
}

/** Synthetic user-convertible message injected in front of an assistant-led window. */
function makeFifoNotice(dropped: number, timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: FIFO_NOTICE_CUSTOM_TYPE,
		content: [
			{
				type: "text",
				text:
					`[PENpi FIFO] ${dropped} earlier message(s) rolled out of the context window for this call. ` +
					"The verbatim history remains in the session transcript (search_transcript) and durable facts in Penfield (recall/search).",
			},
		],
		display: false,
		timestamp,
	} as AgentMessage;
}
