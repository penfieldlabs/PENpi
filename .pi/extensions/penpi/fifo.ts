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
	/** Estimated tokens of the kept messages (excludes non-message overhead). */
	keptMessageTokens: number;
}

/**
 * Tracks what pi's usage report can't tell us: the non-message overhead
 * (system prompt + tool definitions) in tokens. See planFifoFromUsage.
 */
export interface FifoTriggerState {
	overheadTokens: number;
}

export function newFifoTriggerState(): FifoTriggerState {
	return { overheadTokens: 0 };
}

/** Never let a learned overhead starve the message budget entirely. */
const MAX_OVERHEAD_FRACTION = 0.5;

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
	if (reportedTokens != null) {
		// Only meaningful while the reported usage still covers the whole list —
		// once we start pruning this goes negative and the cached max is kept.
		const observed = reportedTokens - messageTokens;
		if (observed > state.overheadTokens) state.overheadTokens = observed;
	}
	if (contextWindow > 0) {
		state.overheadTokens = Math.min(state.overheadTokens, contextWindow * MAX_OVERHEAD_FRACTION);
	}
	const estimatedTokens = messageTokens + state.overheadTokens;
	const triggerTokens = reportedTokens == null ? estimatedTokens : Math.max(estimatedTokens, reportedTokens);
	return planFifo(messages, contextWindow, triggerTokens, cfg);
}

/** PENpi's own injected messages (any generation). */
function isPenpiMessage(m: AgentMessage): boolean {
	return m.role === "custom" && typeof m.customType === "string" && m.customType.startsWith("penpi-");
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
): FifoPlan {
	const ceilingTokens = cfg.contextCeiling * contextWindow;
	if (!contextWindow || currentTokens <= ceilingTokens) {
		return { triggered: false, messages, dropped: 0, keptMessageTokens: 0 };
	}

	const perMessage = messages.map(estimateTokens);
	const totalMessageTokens = perMessage.reduce((a, b) => a + b, 0);
	// Non-message overhead (system prompt, tool definitions) we can't evict.
	const overhead = Math.max(0, currentTokens - totalMessageTokens);
	const floorTokens = cfg.contextFloor * contextWindow;
	const messageBudget = Math.max(0, floorTokens - overhead);

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
		return { triggered: false, messages, dropped: 0, keptMessageTokens: used };
	}
	return { triggered: true, messages: kept, dropped, keptMessageTokens: used };
}
