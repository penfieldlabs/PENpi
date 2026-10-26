/**
 * Context engine (spike). A pure extension for stock Pi 1.1.0 that replaces compaction with a
 * persistent, monotone FIFO window. No LLM summarization is ever requested.
 *
 *   E1 compaction hard-off: cancels every session_before_compact reason (manual /compact advances
 *      the window instead), answers /tree summaries with a fixed notice, warns when the
 *      `compaction.enabled` setting is still on.
 *   E2 persistent window with hysteresis. Modes:
 *      "a"            a context_with_system handler applies a cut persisted in a custom entry; system
 *                     messages before the cut fold into a fixed checkpoint, later ones stay in place.
 *      "a-context"    same, from a plain `context` handler (Pi then collapses every system message
 *                     into one head, so any prompt/tool change rewrites the whole prefix).
 *      "b-compaction" the cut is written at turn_end/agent_before_settle as a `compaction` draft with a
 *                     fixed deterministic notice (no model call); Pi's projection applies it.
 *      "b-edit"       the cut is written as one `context_edit` omission per dropped entry.
 *      "stateless"    baseline: today's PENpi behaviour, re-cut every request with no memory.
 *   E3 calibration from the request actually sent (observed in context_with_system).
 *   E4 per-unit cap (tool results, user messages) at request time; full content stays in the session
 *      entry and is paged back with `context_recall`.
 *   E5 overflow recovery at agent_before_settle: shrink believed window, omit failed attempt, retry.
 *   E6 length continuation at turn_end.
 *   E7 effective limits: unverified metadata, overrides, conservative default, output clamp.
 *   E8 pinned working notes and pinned task (`context_notes`), carried in the window header.
 */
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, isContextOverflow, Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ProjectedSessionEntry,
	SessionBoundaryDraft,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<typeof estimateTokens>[0];

export type EngineMode = "a" | "a-context" | "b-compaction" | "b-edit" | "stateless";

export interface EngineOptions {
	mode: EngineMode;
	/** Cut when the projected request exceeds this fraction of the input budget. */
	highWater: number;
	/** A cut keeps the projected request at or below this fraction of the input budget. */
	lowWater: number;
	/** b modes: request-time guard trims in-request above this fraction (should not fire normally). */
	guardFraction: number;
	/** b modes, agent_before_settle: headroom kept for the next user prompt (fraction of budget). */
	promptReserveFraction: number;
	/** E4: one tool result / user message may use at most this fraction of the input budget. */
	maxUnitFraction: number;
	/** Fraction of the window reserved for output, capped by the effective max output. */
	outputReserveFraction: number;
	/** E7 defaults for unverified models. */
	defaultWindow: number;
	defaultMaxOutput: number;
	limitOverrides: Record<string, { contextWindow?: number; maxTokens?: number }>;
	/** E3: false pins the ratio at 1 (for comparison tests). */
	calibrate: boolean;
	maxLengthContinuations: number;
	maxOverflowRetries: number;
	notesMaxChars: number;
	taskMaxChars: number;
	log?: (line: string) => void;
	/** Shared across reloads so tests can observe the engine. */
	stats?: EngineStats;
}

export interface EngineStats {
	cuts: Array<{ seq: number; mode: string; where: string; omitted: number; before: number; after: number }>;
	guardTrims: number;
	capped: number;
	overflowRetries: number;
	lengthContinuations: number;
	alignMismatches: number;
	cancelledCompactions: Record<string, number>;
	calibrationSamples: number[];
	sent: Array<{ estimate: number; ratio: number; budget: number }>;
	clampedOutput: number;
	/** Milliseconds spent in the request-time handler, per request. */
	handlerMs: number[];
}

export function newStats(): EngineStats {
	return {
		cuts: [],
		guardTrims: 0,
		capped: 0,
		overflowRetries: 0,
		lengthContinuations: 0,
		alignMismatches: 0,
		cancelledCompactions: {},
		calibrationSamples: [],
		sent: [],
		clampedOutput: 0,
		handlerMs: [],
	};
}

const DEFAULTS: EngineOptions = {
	mode: "a",
	highWater: 0.75,
	lowWater: 0.45,
	guardFraction: 0.97,
	promptReserveFraction: 0.03,
	maxUnitFraction: 0.25,
	outputReserveFraction: 0.2,
	defaultWindow: 32_768,
	defaultMaxOutput: 4_096,
	limitOverrides: {},
	calibrate: true,
	maxLengthContinuations: 3,
	maxOverflowRetries: 3,
	notesMaxChars: 4_000,
	taskMaxChars: 2_000,
};

/** customType of the engine's state entries (custom, never in context). */
export const STATE_TYPE = "context-engine";
/** customType of the window header in mode "a" (a context-only custom message, never persisted). */
export const HEADER_TYPE = "context-engine.window";
export const CONTINUE_TYPE = "context-engine.continue";
export const NOTES_TOOL = "context_notes";
export const RECALL_TOOL = "context_recall";

interface CutState {
	firstKeptEntryId: string;
	seq: number;
	header: string;
}
interface Calibration {
	ratio: number;
	samples: number;
}
interface Limits {
	window: number;
	maxOutput: number;
	budget: number;
	verified: boolean;
	source: string;
	key: string;
}

/** One model-visible message of the projection, with the entry that owns it. */
interface Slot {
	entryId: string;
	message: AgentMessage;
	out: AgentMessage;
	tokens: number;
	startable: boolean;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments)})`;
			return "";
		})
		.join("\n");
}

function isStartable(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "custom":
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant": {
			const stop = (message as AssistantMessage).stopReason;
			return stop !== "error" && stop !== "aborted";
		}
		default:
			return false;
	}
}

/** E4: cap one message to `maxChars`, keeping head and tail and a pointer to the full entry. */
export function capMessage(message: AgentMessage, entryId: string, maxChars: number): AgentMessage | undefined {
	if (message.role !== "toolResult" && message.role !== "user" && message.role !== "custom") return undefined;
	if (message.role === "custom" && message.customType.startsWith(STATE_TYPE)) return undefined;
	const content = message.content;
	const text = textOfContent(content);
	if (text.length <= maxChars) return undefined;
	const head = Math.floor(maxChars * 0.7);
	const tail = Math.floor(maxChars * 0.2);
	const marker =
		`\n\n[context-engine: characters ${head}-${text.length - tail} of ${text.length} are not shown here. ` +
		`The full content is kept verbatim in session entry ${entryId}; read it with ` +
		`${RECALL_TOOL}({ "entry": "${entryId}", "offset": ${head} }).]\n\n`;
	const images = Array.isArray(content)
		? (content as Array<TextContent | ImageContent>).filter((b) => b.type === "image")
		: [];
	const capped = [
		{ type: "text" as const, text: text.slice(0, head) + marker + text.slice(text.length - tail) },
		...images,
	];
	return { ...message, content: capped } as AgentMessage;
}

const NUMBER = "([\\d,]+)";
const LIMIT_PATTERNS = [
	`>\\s*${NUMBER}\\s*maximum`,
	`maximum context length is ${NUMBER}`,
	`maximum context length of ${NUMBER}`,
	`maximum context length \\(${NUMBER}\\)`,
	`context length \\(${NUMBER} tokens\\)`,
	`tokens allowed \\(${NUMBER}\\)`,
	`limit of ${NUMBER}`,
	`context size is ${NUMBER}`,
	`maximum prompt length is ${NUMBER}`,
].map((p) => new RegExp(p, "i"));
const REQUEST_PATTERNS = [
	`${NUMBER} tokens? >`,
	`requested (?:about )?${NUMBER} tokens`,
	`request contains ${NUMBER} tokens`,
	`input token count \\(${NUMBER}\\)`,
	`input length \\(?${NUMBER}\\)? exceeds`,
	`prompt has ${NUMBER} tokens`,
	`prompt token count of ${NUMBER}`,
	`the input \\(${NUMBER} tokens\\)`,
	`prompt contains ${NUMBER} tokens`,
].map((p) => new RegExp(p, "i"));

function firstNumber(patterns: RegExp[], text: string | undefined): number | undefined {
	if (!text) return undefined;
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) return Number(match[1].replace(/,/g, ""));
	}
	return undefined;
}

/** The provider's stated limit, and the size it counted for the rejected request, when the error says. */
export function parseOverflow(errorMessage: string | undefined): { limit?: number; requested?: number } {
	return { limit: firstNumber(LIMIT_PATTERNS, errorMessage), requested: firstNumber(REQUEST_PATTERNS, errorMessage) };
}

function contributesMessages(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

export function createContextEngine(overrides: Partial<EngineOptions> = {}): ExtensionFactory {
	const opts: EngineOptions = { ...DEFAULTS, ...overrides };
	const stats = opts.stats ?? newStats();
	const log = (line: string) => opts.log?.(`[${opts.mode}] ${line}`);

	return (pi: ExtensionAPI) => {
		let calib: Calibration = { ratio: 1, samples: 0 };
		let persistedRatio = 1;
		let learnedWindows: Record<string, number> = {};
		let lastSent: { estimate: number } | undefined;
		let overflowRetries = 0;
		let lengthContinuations = 0;
		let seqCache = 0;

		// ---------------------------------------------------------------- state
		function loadState(ctx: ExtensionContext): void {
			itemCache = new WeakMap();
			calib = { ratio: 1, samples: 0 };
			learnedWindows = {};
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
				const data = entry.data as {
					kind?: string;
					ratio?: number;
					samples?: number;
					windows?: Record<string, number>;
				};
				if (data.kind === "calib" && typeof data.ratio === "number")
					calib = { ratio: data.ratio, samples: data.samples ?? 0 };
				if (data.kind === "limits" && data.windows) learnedWindows = { ...data.windows };
			}
			persistedRatio = calib.ratio;
			seqCache = readCut(ctx.sessionManager.getBranch())?.seq ?? 0;
			log(
				`state loaded ratio=${calib.ratio.toFixed(3)} samples=${calib.samples} windows=${JSON.stringify(learnedWindows)} seq=${seqCache}`,
			);
		}

		/** Latest cut on the branch: a custom entry (mode a) or an engine compaction (b-compaction). */
		function readCut(branch: SessionEntry[]): CutState | undefined {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "custom" && entry.customType === STATE_TYPE) {
					const data = entry.data as { kind?: string } & Partial<CutState>;
					if (data.kind === "cut" && data.firstKeptEntryId) {
						return { firstKeptEntryId: data.firstKeptEntryId, seq: data.seq ?? 0, header: data.header ?? "" };
					}
				}
				if (entry.type === "compaction") {
					const details = entry.details as { engine?: string; seq?: number } | undefined;
					if (details?.engine === STATE_TYPE) {
						return { firstKeptEntryId: entry.firstKeptEntryId, seq: details.seq ?? 0, header: entry.summary };
					}
				}
			}
			return undefined;
		}

		function ratio(): number {
			return opts.calibrate ? Math.max(calib.ratio, 0.25) : 1;
		}

		// --------------------------------------------------------------- limits (E7)
		function resolveLimits(ctx: ExtensionContext): Limits {
			const model = ctx.model;
			const key = model ? `${model.provider}/${model.id}` : "?";
			const override = opts.limitOverrides[key];
			const registered = model ? ctx.modelRegistry.find(model.provider, model.id) : undefined;
			const declaredWindow = model && model.contextWindow > 0 ? model.contextWindow : 0;
			const declaredMax = model && model.maxTokens > 0 ? model.maxTokens : 0;
			const verified = !!registered && declaredWindow > 0 && declaredMax > 0 && declaredMax < declaredWindow / 2;
			let window: number;
			let source: string;
			if (override?.contextWindow) {
				window = override.contextWindow;
				source = "override";
			} else if (declaredWindow > 0 && registered) {
				window = declaredWindow;
				source = verified ? "metadata" : "metadata(unverified)";
			} else if (declaredWindow > 0) {
				window = Math.min(declaredWindow, opts.defaultWindow);
				source = "unregistered->default";
			} else {
				window = opts.defaultWindow;
				source = "missing->default";
			}
			const learned = learnedWindows[key];
			if (learned && learned < window) {
				window = learned;
				source += "+learned";
			}
			const maxOutput =
				override?.maxTokens ??
				(declaredMax > 0 && declaredMax < window / 2
					? declaredMax
					: Math.min(opts.defaultMaxOutput, Math.floor(window / 4)));
			const reserve = Math.min(maxOutput, Math.floor(window * opts.outputReserveFraction));
			return { window, maxOutput, budget: window - reserve, verified, source, key };
		}

		function maxUnitChars(limits: Limits): number {
			// Ratio-independent so caps stay byte-stable while the calibration moves.
			return Math.max(2_000, Math.floor(limits.budget * opts.maxUnitFraction * 3));
		}

		// --------------------------------------------------------------- header (E8)
		function pinned(branch: SessionEntry[]): { task: string; notes: string } {
			let task = "";
			let notes = "";
			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (!task && message.role === "user") task = textOfContent(message.content).slice(0, opts.taskMaxChars);
				if (message.role === "toolResult" && message.toolName === NOTES_TOOL && !message.isError) {
					const details = message.details as { notes?: string; task?: string } | undefined;
					if (details?.notes !== undefined) notes = details.notes;
					if (details?.task) task = details.task;
				}
			}
			return { task, notes };
		}

		function makeHeader(seq: number, _omitted: number, firstKeptEntryId: string, branch: SessionEntry[]): string {
			const { task, notes } = pinned(branch);
			let omitted = 0;
			for (const entry of branch) {
				if (entry.id === firstKeptEntryId) break;
				if (entry.type === "message" && entry.message.role !== "system") omitted++;
				else if (entry.type === "custom_message") omitted++;
			}
			const lines = [
				`[context window #${seq}] The ${omitted} oldest messages of this session (everything before entry ${firstKeptEntryId}) are no longer in your context, to keep requests within the model's limit.`,
				"Nothing was summarized and nothing was deleted: the complete transcript is kept verbatim. Use search_transcript to find earlier work and context_recall to read any entry by id. Keep your plan and open threads in context_notes; they are carried into every window.",
			];
			if (task) lines.push(`<pinned-task>\n${task}\n</pinned-task>`);
			if (notes) lines.push(`<working-notes>\n${notes}\n</working-notes>`);
			return lines.join("\n");
		}

		function headerMessage(header: string): AgentMessage {
			if (opts.mode === "b-compaction") {
				// Same shape Pi projects for a compaction entry, so materializing the cut later is byte-identical.
				return { role: "compactionSummary", summary: header, tokensBefore: 0, timestamp: 0 } as AgentMessage;
			}
			return {
				role: "custom",
				customType: HEADER_TYPE,
				content: header,
				display: false,
				timestamp: 0,
			} as AgentMessage;
		}

		// --------------------------------------------------------------- planning (E2)
		function buildSlots(
			entries: ProjectedSessionEntry[],
			limits: Limits,
		): { slots: Slot[]; overhead: AgentMessage[] } {
			const maxChars = maxUnitChars(limits);
			const slots: Slot[] = [];
			const overhead: AgentMessage[] = [];
			for (const projected of entries) {
				const isEngineCompaction = projected.sourceEntry.type === "compaction";
				for (const message of projected.messages) {
					if (message.role === "system" || isEngineCompaction) {
						overhead.push(message);
						continue;
					}
					const capped = capMessage(message, projected.sourceEntry.id, maxChars);
					const out = capped ?? message;
					slots.push({
						entryId: projected.sourceEntry.id,
						message,
						out,
						tokens: estimateTokens(out),
						startable: isStartable(message),
					});
				}
			}
			return { slots, overhead };
		}

		function suffixSums(slots: Slot[]): number[] {
			const sums = new Array<number>(slots.length + 1).fill(0);
			for (let i = slots.length - 1; i >= 0; i--) sums[i] = sums[i + 1] + slots[i].tokens;
			return sums;
		}

		/** Smallest startable index >= from whose window fits `target` (provider tokens). */
		function chooseStart(
			slots: Slot[],
			from: number,
			fixedTokens: number,
			target: number,
			strictlyAfter = false,
		): number {
			const sums = suffixSums(slots);
			let lastStartable = -1;
			for (let s = strictlyAfter ? from + 1 : from; s < slots.length; s++) {
				if (!slots[s].startable) continue;
				// A window may start at the same entry as a startable message only once per entry.
				if (s > 0 && slots[s - 1].entryId === slots[s].entryId) continue;
				lastStartable = s;
				if ((fixedTokens + sums[s]) * ratio() <= target) return s;
			}
			return lastStartable >= 0 ? lastStartable : from;
		}

		function headerTokens(branch: SessionEntry[]): number {
			return estimateTokens(headerMessage(makeHeader(999, 99_999, "xxxxxxxx", branch)));
		}

		// ------------------------------------------------------- request time, mode a-context
		function alignSlots(messages: AgentMessage[], ctx: ExtensionContext, limits: Limits) {
			const projection = ctx.sessionManager.buildSessionProjection();
			const { slots, overhead } = buildSlots(projection.entries, limits);
			const nonSystemOverhead = overhead.filter((m) => m.role !== "system");
			const visible = [...nonSystemOverhead.map((m) => m), ...slots.map((s) => s.message)];
			const aligned = visible.length === messages.length && visible.every((m, i) => m.role === messages[i].role);
			if (!aligned) {
				stats.alignMismatches++;
				log(`align mismatch visible=${visible.length} event=${messages.length}`);
				return undefined;
			}
			const system = getCurrentSystemMessage(projection.messages);
			return { slots, nonSystemOverhead, systemTokens: system ? estimateTokens(system as AgentMessage) : 0 };
		}

		pi.on("context", async (event, ctx) => {
			if (opts.mode !== "a-context") return undefined;
			try {
				const limits = resolveLimits(ctx);
				const aligned = alignSlots(event.messages, ctx, limits);
				if (!aligned) return;
				const { slots, nonSystemOverhead, systemTokens } = aligned;
				const branch = ctx.sessionManager.getBranch();
				const highTarget = opts.highWater * limits.budget;
				const lowTarget = opts.lowWater * limits.budget;
				const anyCapped = slots.some((s) => s.out !== s.message);

				const cut = readCut(branch);
				let start = 0;
				if (cut) {
					const index = slots.findIndex((s) => s.entryId === cut.firstKeptEntryId);
					if (index >= 0) start = index;
					else {
						// The cut entry is no longer projected (tree navigation, omission): keep everything after it.
						const branchIndex = new Map(branch.map((e, i) => [e.id, i]));
						const cutIndex = branchIndex.get(cut.firstKeptEntryId) ?? -1;
						start = cutIndex < 0 ? 0 : slots.findIndex((s) => (branchIndex.get(s.entryId) ?? 0) >= cutIndex);
						if (start < 0) start = 0;
					}
				}
				const fixed = systemTokens + (start > 0 ? headerTokens(branch) : 0);
				const projected = (fixed + suffixSums(slots)[start]) * ratio();
				let header = start > 0 && cut ? cut.header : "";
				if (projected > highTarget) {
					const fixedAfter = systemTokens + headerTokens(branch);
					const next = chooseStart(slots, start, fixedAfter, lowTarget, true);
					const nextSize = (fixedAfter + suffixSums(slots)[next]) * ratio();
					if (next > start && nextSize < projected) {
						const seq = (cut?.seq ?? 0) + 1;
						header = makeHeader(seq, next, slots[next].entryId, branch);
						pi.appendEntry(STATE_TYPE, { kind: "cut", firstKeptEntryId: slots[next].entryId, seq, header });
						const after =
							(systemTokens + estimateTokens(headerMessage(header)) + suffixSums(slots)[next]) * ratio();
						stats.cuts.push({ seq, mode: "a", where: "context", omitted: next, before: projected, after });
						log(
							`cut #${seq} at slot ${next}/${slots.length} entry=${slots[next].entryId} ${Math.round(projected)} -> ${Math.round(after)} (budget ${limits.budget}, ratio ${ratio().toFixed(3)})`,
						);
						start = next;
					}
				}
				if (start === 0 && !anyCapped) return undefined;
				stats.capped += slots.slice(start).filter((s) => s.out !== s.message).length;
				const window = slots.slice(start).map((s) => s.out);
				return { messages: start > 0 ? [headerMessage(header), ...window] : [...nonSystemOverhead, ...window] };
			} catch (error) {
				log(`context handler error: ${error instanceof Error ? error.stack : String(error)}`);
				return undefined;
			}
		});

		// ------------------------------------- request time, modes a / stateless / b guard (+E3, E4)
		interface Item extends Slot {
			system: boolean;
		}

		/** Every projected message in order; the newest engine compaction contributes the fixed head. */
		// Session messages are immutable objects reused by every projection, so per-message work is cached.
		let itemCache = new WeakMap<object, { maxChars: number; out: AgentMessage; tokens: number }>();
		function buildItems(entries: ProjectedSessionEntry[], limits: Limits): { head: Item[]; body: Item[] } {
			const maxChars = maxUnitChars(limits);
			const head: Item[] = [];
			const body: Item[] = [];
			for (const projected of entries) {
				const isCompaction = projected.sourceEntry.type === "compaction";
				for (const message of projected.messages) {
					const system = message.role === "system";
					let cached = itemCache.get(message);
					if (!cached || cached.maxChars !== maxChars) {
						const capped = system ? undefined : capMessage(message, projected.sourceEntry.id, maxChars);
						const out = capped ?? message;
						cached = { maxChars, out, tokens: estimateTokens(out) };
						itemCache.set(message, cached);
					}
					const { out, tokens } = cached;
					const item = {
						entryId: projected.sourceEntry.id,
						message,
						out,
						tokens,
						startable: !system && isStartable(message),
						system,
					};
					(isCompaction && body.length === 0 ? head : body).push(item);
				}
			}
			return { head, body };
		}

		/** Request-time window for modes a, stateless, and the b-mode guard. Returns undefined to send as is. */
		function requestWindow(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] | undefined {
			if (opts.mode === "a-context") return undefined;
			const limits = resolveLimits(ctx);
			const projection = ctx.sessionManager.buildSessionProjection();
			const { head, body } = buildItems(projection.entries, limits);
			const all = [...head, ...body];
			if (all.length !== messages.length || all.some((item, i) => item.message.role !== messages[i].role)) {
				stats.alignMismatches++;
				log(`align mismatch projected=${all.length} event=${messages.length}`);
				return undefined;
			}
			const branch = ctx.sessionManager.getBranch();
			const anyCapped = body.some((item) => item.out !== item.message);
			const asIs = () => {
				if (!anyCapped) return undefined;
				stats.capped += body.filter((item) => item.out !== item.message).length;
				return all.map((item) => item.out);
			};
			const sums = suffixSums(body);
			const fullTokens = all.reduce((sum, item) => sum + item.tokens, 0);
			const checkpoint = (start: number) =>
				getCurrentSystemMessage(
					[...head, ...body.slice(0, start)].filter((i) => i.system).map((i) => i.message) as never,
				) as AgentMessage | undefined;
			const systemNow = getCurrentSystemMessage(all.filter((i) => i.system).map((i) => i.message) as never) as
				| AgentMessage
				| undefined;
			const fixedAfter = (systemNow ? estimateTokens(systemNow) : 0) + headerTokens(branch);
			const cost = (start: number) => (start === 0 ? fullTokens : fixedAfter + sums[start]) * ratio();
			const render = (start: number, header: string): AgentMessage[] => {
				const system = checkpoint(start);
				return [...(system ? [system] : []), headerMessage(header), ...body.slice(start).map((item) => item.out)];
			};
			const highTarget = opts.highWater * limits.budget;
			const lowTarget = opts.lowWater * limits.budget;

			if (opts.mode === "stateless") {
				if (cost(0) <= highTarget) return asIs();
				const start = chooseStart(body, 0, fixedAfter, lowTarget);
				stats.cuts.push({
					seq: 0,
					mode: opts.mode,
					where: "request",
					omitted: start,
					before: cost(0),
					after: cost(start),
				});
				return render(start, "[Earlier messages were dropped from this request.]");
			}

			if (opts.mode === "a") {
				const cut = readCut(branch);
				let start = 0;
				let header = "";
				if (cut) {
					start = body.findIndex((item) => item.entryId === cut.firstKeptEntryId);
					if (start < 0) {
						// The cut entry is not projected any more (omitted, or another branch): keep what follows it.
						const order = new Map(branch.map((e, i) => [e.id, i]));
						const at = order.get(cut.firstKeptEntryId);
						start =
							at === undefined
								? 0
								: Math.max(
										0,
										body.findIndex((item) => (order.get(item.entryId) ?? -1) >= at && item.startable),
									);
					}
					header = cut.header;
				}
				const projected = cost(start);
				if (projected > highTarget) {
					const next = chooseStart(body, start, fixedAfter, lowTarget, true);
					if (next > start && cost(next) < projected) {
						const seq = (cut?.seq ?? 0) + 1;
						header = makeHeader(seq, next, body[next].entryId, branch);
						pi.appendEntry(STATE_TYPE, { kind: "cut", firstKeptEntryId: body[next].entryId, seq, header });
						stats.cuts.push({
							seq,
							mode: "a",
							where: "request",
							omitted: next,
							before: projected,
							after: cost(next),
						});
						log(
							`cut #${seq} at ${next}/${body.length} entry=${body[next].entryId} ${Math.round(projected)} -> ${Math.round(cost(next))} (budget ${limits.budget}, ratio ${ratio().toFixed(3)})`,
						);
						start = next;
					}
				}
				if (start === 0) return asIs();
				stats.capped += body.slice(start).filter((item) => item.out !== item.message).length;
				return render(start, header);
			}

			// b modes: the projection already applies the persisted cut. Guard only.
			const projected = cost(0);
			if (projected <= opts.guardFraction * limits.budget) return asIs();
			const start = chooseStart(body, 0, fixedAfter, lowTarget, true);
			if (start <= 0 || cost(start) >= projected) return asIs();
			stats.guardTrims++;
			log(`guard trim at ${start}/${body.length} projected=${Math.round(projected)}`);
			return render(start, makeHeader(seqCache + 1, start, body[start].entryId, branch));
		}

		pi.on("context_with_system", (event, ctx) => {
			let result: AgentMessage[] | undefined;
			const started = performance.now();
			try {
				result = requestWindow(event.messages, ctx);
			} catch (error) {
				log(`context_with_system error: ${error instanceof Error ? error.stack : String(error)}`);
			}
			// E3: remember the estimate of exactly what is sent; message_end pairs it with provider usage.
			const final = result ?? event.messages;
			const estimate = final.reduce((sum, m) => sum + estimateTokens(m), 0);
			lastSent = { estimate };
			stats.sent.push({ estimate, ratio: ratio(), budget: resolveLimits(ctx).budget });
			stats.handlerMs.push(performance.now() - started);
			return result ? { messages: result } : undefined;
		});

		pi.on("message_end", (event) => {
			const message = event.message;
			if (message.role !== "assistant") return;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return;
			overflowRetries = 0;
			const usage = assistant.usage;
			const reported = usage.input + usage.cacheRead + usage.cacheWrite;
			if (lastSent && lastSent.estimate > 0 && reported > 0) {
				const sample = reported / lastSent.estimate;
				stats.calibrationSamples.push(sample);
				const alpha = calib.samples < 3 ? 0.5 : 0.2;
				calib = {
					ratio: calib.samples === 0 ? sample : calib.ratio * (1 - alpha) + sample * alpha,
					samples: calib.samples + 1,
				};
				if (Math.abs(calib.ratio - persistedRatio) / persistedRatio > 0.03 || calib.samples % 50 === 0) {
					persistedRatio = calib.ratio;
					pi.appendEntry(STATE_TYPE, { kind: "calib", ratio: calib.ratio, samples: calib.samples });
				}
			}
			lastSent = undefined;
		});

		// ---------------------------------------------------------- boundaries (E2 b, E5, E6)
		function planBoundary(
			entries: ProjectedSessionEntry[],
			ctx: ExtensionContext,
			limits: Limits,
			reserveTokens: number,
			force: boolean,
		): SessionBoundaryDraft[] {
			const branch = ctx.sessionManager.getBranch();
			const { slots, overhead } = buildSlots(entries, limits);
			const overheadTokens = overhead.reduce((a, m) => a + estimateTokens(m), 0);
			const projected = (overheadTokens + suffixSums(slots)[0] + reserveTokens) * ratio();
			if (!force && projected <= opts.highWater * limits.budget) return [];
			const system = getCurrentSystemMessage(entries.flatMap((e) => e.messages));
			const fixedAfter =
				(system ? estimateTokens(system as AgentMessage) : 0) + headerTokens(branch) + reserveTokens;
			const target = force
				? Math.min(opts.lowWater * limits.budget, projected * 0.5)
				: opts.lowWater * limits.budget;
			const start = chooseStart(slots, 0, fixedAfter, target, true);
			if (start <= 0) return [];
			const after = (fixedAfter + suffixSums(slots)[start]) * ratio();
			if (after >= projected) return [];
			const seq = seqCache + 1;
			seqCache = seq;
			const firstKeptEntryId = slots[start].entryId;
			const header = makeHeader(seq, start, firstKeptEntryId, branch);
			stats.cuts.push({ seq, mode: opts.mode, where: "boundary", omitted: start, before: projected, after });
			log(
				`boundary cut #${seq} at slot ${start}/${slots.length} entry=${firstKeptEntryId} ${Math.round(projected)} -> ${Math.round(after)}`,
			);
			if (opts.mode === "b-compaction") {
				return [{ type: "compaction", summary: header, firstKeptEntryId, details: { engine: STATE_TYPE, seq } }];
			}
			// b-edit: omit every dropped entry; the first kept user-role entry carries the header.
			const drafts: SessionBoundaryDraft[] = [];
			const dropped = [...new Set(slots.slice(0, start).map((s) => s.entryId))];
			let anchor = slots[start];
			if (!(anchor.message.role === "user" || anchor.message.role === "custom")) {
				const previousUser = [...slots.slice(0, start)].reverse().find((s) => s.message.role === "user");
				if (previousUser) anchor = previousUser;
			}
			for (const entryId of dropped) {
				if (entryId === anchor.entryId) continue;
				drafts.push({ type: "context_edit", targetId: entryId, replacement: null });
			}
			if (anchor.message.role === "user" || anchor.message.role === "custom") {
				// Rebuild from the raw entry, not the projection (which may already carry an older header).
				const raw = ctx.sessionManager.getEntry(anchor.entryId);
				const original =
					raw?.type === "message"
						? textOfContent((raw.message as { content: unknown }).content)
						: raw?.type === "custom_message"
							? textOfContent(raw.content)
							: "";
				drafts.push({
					type: "context_edit",
					targetId: anchor.entryId,
					replacement: { content: `${header}\n\n${original}` },
				});
			}
			return drafts;
		}

		function capDrafts(entryIds: string[], ctx: ExtensionContext, limits: Limits): SessionBoundaryDraft[] {
			const drafts: SessionBoundaryDraft[] = [];
			for (const id of entryIds) {
				const entry = ctx.sessionManager.getEntry(id);
				if (!entry || entry.type !== "message") continue;
				const capped = capMessage(entry.message as AgentMessage, id, maxUnitChars(limits));
				if (!capped) continue;
				drafts.push({
					type: "context_edit",
					targetId: id,
					replacement: { content: (capped as unknown as { content: never }).content },
				});
			}
			return drafts;
		}

		pi.on("turn_end", (event, ctx) => {
			const drafts: SessionBoundaryDraft[] = [...event.entries];
			let shouldContinue = event.continue;
			const message = event.message as AssistantMessage;
			// E6: length continuation, bounded.
			if (message.role === "assistant" && message.stopReason === "length") {
				const hasToolCalls = message.content.some((block) => block.type === "toolCall");
				if (!hasToolCalls && lengthContinuations < opts.maxLengthContinuations) {
					lengthContinuations++;
					stats.lengthContinuations++;
					drafts.push({
						type: "custom_message",
						customType: CONTINUE_TYPE,
						content:
							"Your previous response reached the output token limit and was cut off. Continue exactly where it stopped, without repeating what you already wrote.",
						display: false,
					});
					shouldContinue = true;
				}
			}
			if (opts.mode === "b-compaction" || opts.mode === "b-edit") {
				const limits = resolveLimits(ctx);
				drafts.push(...capDrafts(event.toolResultEntryIds, ctx, limits));
				const preview = event.context.contextEntries;
				drafts.push(...planBoundary(preview, ctx, limits, 0, false));
			}
			if (drafts.length === event.entries.length && shouldContinue === event.continue) return undefined;
			return { entries: drafts, continue: shouldContinue };
		});

		pi.on("agent_before_settle", (event, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const projection = event.context.contextEntries;
			// E5: the final attempt overflowed. Find it in the projection (Pi may already have omitted it).
			const lastAssistant = [...branch]
				.reverse()
				.find((e) => e.type === "message" && e.message.role === "assistant");
			const failed =
				lastAssistant?.type === "message" &&
				(lastAssistant.message as AssistantMessage).stopReason === "error" &&
				isContextOverflow(lastAssistant.message as AssistantMessage)
					? lastAssistant
					: undefined;
			if (failed && failed.type === "message") {
				if (overflowRetries >= opts.maxOverflowRetries) {
					log("overflow retry budget exhausted");
					return undefined;
				}
				overflowRetries++;
				stats.overflowRetries++;
				const limits = resolveLimits(ctx);
				const errorMessage = (failed.message as AssistantMessage).errorMessage;
				const { limit, requested } = parseOverflow(errorMessage);
				const drafts: SessionBoundaryDraft[] = [...event.entries];
				// The error's own token count is the best calibration sample there is.
				if (opts.calibrate && requested && lastSent && requested / lastSent.estimate > calib.ratio) {
					calib = { ratio: requested / lastSent.estimate, samples: calib.samples + 1 };
					persistedRatio = calib.ratio;
					drafts.push({ type: "custom", customType: STATE_TYPE, data: { kind: "calib", ...calib } });
				}
				const sent = requested ?? (lastSent ? lastSent.estimate * ratio() : limits.window);
				let shrunk = limits.window;
				if (limit && limit < limits.window) shrunk = limit;
				else if (limit && !(opts.calibrate && requested)) {
					// The limit is not smaller than our window, so our units are off and cannot be recalibrated: go below what we sent.
					shrunk = Math.min(limits.window, Math.floor((lastSent?.estimate ?? sent) * ratio() * 0.85));
				} else if (!limit && (sent >= 0.5 * limits.window || overflowRetries > 1)) {
					shrunk = Math.min(limits.window, Math.floor(sent * 0.85));
				}
				// Otherwise (implausibly small request, unparseable error): retry unchanged once before believing it.
				if (shrunk < limits.window) learnedWindows = { ...learnedWindows, [limits.key]: shrunk };
				log(
					`overflow: "${errorMessage}" limit=${limit} requested=${requested} sent=${Math.round(sent)} ratio=${ratio().toFixed(3)} window ${limits.window} -> ${shrunk}`,
				);
				const alreadyOmitted = !projection.some((e) => e.sourceEntry.id === failed.id && e.messages.length > 0);
				if (!alreadyOmitted) drafts.push({ type: "context_edit", targetId: failed.id, replacement: null });
				if (shrunk < limits.window)
					drafts.push({
						type: "custom",
						customType: STATE_TYPE,
						data: { kind: "limits", windows: learnedWindows },
					});
				if (opts.mode === "b-compaction" || opts.mode === "b-edit") {
					const remaining = projection.filter((e) => e.sourceEntry.id !== failed.id);
					drafts.push(...planBoundary(remaining, ctx, resolveLimits(ctx), 0, false));
				}
				return { entries: drafts, continue: true };
			}
			if (opts.mode === "b-compaction" || opts.mode === "b-edit") {
				const limits = resolveLimits(ctx);
				const cut = planBoundary(projection, ctx, limits, opts.promptReserveFraction * limits.budget, false);
				if (cut.length > 0) return { entries: [...event.entries, ...cut] };
			}
			return undefined;
		});

		pi.on("agent_settled", () => {
			lengthContinuations = 0;
		});

		// --------------------------------------------------------------- E1
		pi.on("session_before_compact", (event, ctx) => {
			stats.cancelledCompactions[event.reason] = (stats.cancelledCompactions[event.reason] ?? 0) + 1;
			if (event.reason !== "manual") return { cancel: true };
			// Manual /compact advances the window. No model call.
			const limits = resolveLimits(ctx);
			const branch = ctx.sessionManager.getBranch();
			const projection = ctx.sessionManager.buildSessionProjection();
			if (opts.mode === "b-compaction") {
				const drafts = planBoundary(projection.entries, ctx, limits, 0, true);
				const draft = drafts.find((d) => d.type === "compaction");
				if (draft && draft.type === "compaction" && draft.firstKeptEntryId) {
					return {
						compaction: {
							summary: draft.summary,
							firstKeptEntryId: draft.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: draft.details,
						},
					};
				}
				return { cancel: true };
			}
			if (opts.mode === "a" || opts.mode === "a-context") {
				const { slots } = buildSlots(projection.entries, limits);
				const cut = readCut(branch);
				let start = cut
					? Math.max(
							0,
							slots.findIndex((s) => s.entryId === cut.firstKeptEntryId),
						)
					: 0;
				const system = getCurrentSystemMessage(projection.messages);
				const fixed = (system ? estimateTokens(system as AgentMessage) : 0) + headerTokens(branch);
				const current = (fixed + suffixSums(slots)[start]) * ratio();
				const next = chooseStart(slots, start, fixed, Math.min(opts.lowWater * limits.budget, current * 0.5), true);
				if (next > start) {
					const seq = (cut?.seq ?? 0) + 1;
					const header = makeHeader(seq, next, slots[next].entryId, branch);
					pi.appendEntry(STATE_TYPE, { kind: "cut", firstKeptEntryId: slots[next].entryId, seq, header });
					stats.cuts.push({ seq, mode: "a", where: "manual", omitted: next, before: current, after: 0 });
					start = next;
					ctx.ui.notify(`Context window advanced (window #${seq}); nothing was summarized.`, "info");
				}
			}
			return { cancel: true };
		});

		pi.on("session_before_tree", (event) => {
			if (!event.preparation.userWantsSummary) return undefined;
			return {
				summary: {
					summary:
						`The conversation came back from another branch (left at entry ${event.preparation.oldLeafId}). ` +
						"No summary was generated; the abandoned branch is kept verbatim in the transcript.",
				},
			};
		});

		// --------------------------------------------------------------- E7 output clamp
		pi.on("before_provider_request", (event, ctx) => {
			const payload = event.payload;
			if (!payload || typeof payload !== "object") return undefined;
			const limits = resolveLimits(ctx);
			const input = lastSent ? lastSent.estimate * ratio() : 0;
			const allowed = Math.max(256, Math.min(limits.maxOutput, Math.floor(limits.window - input - 512)));
			const next = { ...(payload as Record<string, unknown>) };
			let changed = false;
			const clamp = (holder: Record<string, unknown>, key: string) => {
				const value = holder[key];
				if (typeof value === "number" && value > allowed) {
					holder[key] = allowed;
					changed = true;
				}
			};
			for (const key of [
				"max_tokens",
				"max_completion_tokens",
				"max_output_tokens",
				"maxTokens",
				"maxOutputTokens",
			]) {
				clamp(next, key);
			}
			for (const nested of ["generationConfig", "inferenceConfig"]) {
				if (next[nested] && typeof next[nested] === "object") {
					next[nested] = { ...(next[nested] as Record<string, unknown>) };
					clamp(
						next[nested] as Record<string, unknown>,
						nested === "generationConfig" ? "maxOutputTokens" : "maxTokens",
					);
				}
			}
			const thinking = next.thinking as { budget_tokens?: number } | undefined;
			if (changed && thinking && typeof thinking.budget_tokens === "number" && typeof next.max_tokens === "number") {
				next.thinking = {
					...thinking,
					budget_tokens: Math.min(thinking.budget_tokens, Math.max(1024, (next.max_tokens as number) - 1)),
				};
			}
			if (!changed) return undefined;
			stats.clampedOutput++;
			return next;
		});

		// --------------------------------------------------------------- tools (E4, E8)
		pi.registerTool({
			name: NOTES_TOOL,
			label: "Context notes",
			description:
				"Replace your pinned working notes: a short block (goal, decisions, open threads, next steps) that stays in your context permanently, even after older messages leave the window. Optionally replace the pinned task statement.",
			parameters: Type.Object({
				notes: Type.String({ description: "The complete new notes block (replaces the previous one)." }),
				task: Type.Optional(Type.String({ description: "Replace the pinned task statement." })),
			}),
			execute: async (_id, params) => {
				if (params.notes.length > opts.notesMaxChars) {
					throw new Error(
						`Notes are ${params.notes.length} characters; the limit is ${opts.notesMaxChars}. Shorten them.`,
					);
				}
				const task = params.task?.slice(0, opts.taskMaxChars);
				return {
					content: [
						{ type: "text", text: `Pinned notes updated (${params.notes.length}/${opts.notesMaxChars} chars).` },
					],
					details: { notes: params.notes, ...(task ? { task } : {}) },
				};
			},
		});

		pi.registerTool({
			name: RECALL_TOOL,
			label: "Context recall",
			description:
				"Read the verbatim content of a session entry by id (for content shown truncated or messages that left the context window), in pages.",
			parameters: Type.Object({
				entry: Type.String(),
				offset: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
			}),
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				const entry = ctx.sessionManager.getEntry(params.entry);
				if (!entry || !contributesMessages(entry)) throw new Error(`No readable entry ${params.entry}`);
				const content =
					entry.type === "message"
						? (entry.message as { content?: unknown }).content
						: entry.type === "custom_message"
							? entry.content
							: entry.type === "branch_summary"
								? entry.summary
								: "";
				const text = textOfContent(content);
				const page = Math.min(
					params.limit ?? Number.POSITIVE_INFINITY,
					Math.floor(maxUnitChars(resolveLimits(ctx)) * 0.9),
				);
				const offset = Math.max(0, params.offset ?? 0);
				const slice = text.slice(offset, offset + page);
				return {
					content: [
						{
							type: "text",
							text: `[entry ${params.entry} characters ${offset}-${offset + slice.length} of ${text.length}]\n${slice}`,
						},
					],
					details: { entry: params.entry, offset, length: slice.length, total: text.length },
				};
			},
		});

		pi.on("session_start", (_event, ctx) => {
			loadState(ctx);
			const settings = pi.getSettings();
			if (settings.compaction?.enabled !== false) {
				ctx.ui.notify(
					"context-engine: set compaction.enabled to false; the engine cancels every compaction but Pi still omits a failed final attempt before asking.",
					"warning",
				);
			}
		});
		pi.on("session_tree", (_event, ctx) => loadState(ctx));
	};
}

export default createContextEngine();
