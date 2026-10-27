/**
 * Context engine (spike, round 5). A pure extension for stock Pi 1.1.0 that replaces compaction with a
 * persistent, monotone FIFO window. No LLM summarization is ever requested. BEHAVIOURS.md (next to this
 * file) lists every behaviour with its configuration and the test that proves it.
 *
 *   E1 compaction hard-off: cancels every session_before_compact reason (manual /compact advances the
 *      window instead), answers /tree summaries with a fixed notice. P5: refuses to run while the
 *      `compaction.enabled` setting is not false.
 *   E2 persistent window with hysteresis. Modes:
 *      "a"            (recommended) a context_with_system handler applies a cut persisted in a custom
 *                     entry, from an incremental index of the window (H7); system messages before the
 *                     cut fold into a fixed checkpoint, later ones stay in place.
 *      "a-context"    same from a plain `context` handler (comparison only).
 *      "b-compaction" the cut is a `compaction` draft with a fixed notice, written at turn_end /
 *                     agent_before_settle; Pi's projection applies it.
 *      "b-edit"       the cut is one `context_edit` omission per dropped entry.
 *      "stateless"    baseline: re-cut every request with no memory (today's PENpi).
 *   E3 calibration from the request actually sent, per model (H2), relative to a character-class
 *      density estimator fitted on o200k_base and GLM tokenizers (H1, H6), with a ratio floor. R5: a
 *      silent-truncation detector that needs no plateau: requests that only grew must report about what
 *      was appended; samples that do not are quarantined (they never move the ratio) and are evidence.
 *   E4 per-unit caps sized in estimated real tokens and frozen at first decision (H6), images included;
 *      everything stays recallable with `context_recall`.
 *   E5 overflow recovery at agent_before_settle; learned windows carry evidence and are re-probed (H3).
 *   E6 length continuation at turn_end; clamp-caused truncation raises the output limit, repeated
 *      stops at one output count teach the provider's real ceiling (H4).
 *   E7 effective limits: overrides, plausibility of metadata, default output 16,384 (H4).
 *   E8 pinned working notes and the pinned task (the prompt of the current run, H5) in the header.
 *   P4 shortly before a cut, a request-only notice at the tail names what will leave view; G3: once per
 *      cut cycle (noticeRepeats restores round 2), and no cache-breakpoint surgery by default.
 *   H8 plans against min(model window, windowCeiling = 200k); status line and `/penpi doctor`.
 *   G1 provider errors are classified before Pi's isContextOverflow: output-limit errors and combined
 *      (input + output) errors whose input fits teach the output ceiling or room and are retried,
 *      bounded, without shrinking the window.
 *   G2 a plateau names the answers produced from truncated input; `/penpi reset-limits`.
 *   D1 fault injection (PENPI_FAULTS or `faults`), refused in production (PENPI_PRODUCTION=1).
 *   D2 a short run prompt keeps the pinned task and is carried as the latest instruction.
 *   R5 `context_search` finds text that left the window; the header and notices name only active tools;
 *      `notice: false` switches the pre-cut notice off.
 */
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, isContextOverflow, Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	estimateTokens,
	ProjectedSessionEntry,
	SessionBoundaryDraft,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<typeof estimateTokens>[0];

export type EngineMode = "a" | "a-context" | "b-compaction" | "b-edit" | "stateless";

/** P2: the user-message pin. Tokens are estimated (textTokens); the cap is a fraction of the window. */
export interface PinUserMessagesOptions {
	/** The pinned block stays within this fraction of the window. */
	capFraction: number;
	/** The session's first this-many user messages are dropped last (standing instructions come first). */
	protectFirst: number;
	/** A user message longer than this (a paste) is carried as a pointer, not verbatim. */
	longMessageChars: number;
}

export interface EngineOptions {
	mode: EngineMode;
	/** Cut when the projected request exceeds this fraction of the input budget. */
	highWater: number;
	/** A cut keeps the projected request at or below this fraction of the input budget. */
	lowWater: number;
	/** b modes: request-time guard trims in-request above this fraction. */
	guardFraction: number;
	/** b modes, agent_before_settle: headroom kept for the next user prompt (fraction of budget). */
	promptReserveFraction: number;
	/** One tool result / user message may use at most this fraction of the input budget. */
	maxUnitFraction: number;
	/** Fraction of the window reserved for output, capped by the effective max output. */
	outputReserveFraction: number;
	/** Window for models without (trustworthy) metadata. */
	defaultWindow: number;
	/** H4: max output when maxTokens is missing or implausible. 16,384 = Pi's own response reserve. */
	defaultMaxOutput: number;
	/** H4: maxTokens above this fraction of the window is treated as implausible. */
	implausibleOutputFraction: number;
	/**
	 * Per-model limits by "provider/modelId". An explicit contextWindow here bypasses windowCeiling
	 * (the more specific, deliberate setting wins); maxTokens replaces the resolved max output.
	 */
	limitOverrides: Record<string, { contextWindow?: number; maxTokens?: number }>;
	/** Alias of limitOverrides (merged over it). */
	modelLimits?: Record<string, { contextWindow?: number; maxTokens?: number }>;
	/** H8: plan against min(model window, windowCeiling). 0 or null disables the ceiling. */
	windowCeiling: number | null;
	/** Name of the diagnostic command (`/<name> doctor`). */
	commandName: string;
	/** E3: false pins the ratio at 1. */
	calibrate: boolean;
	/** H1: bounds of the learned ratio (provider tokens per estimated token). */
	ratioFloor: number;
	ratioCeiling: number;
	/** Legacy (r2 plateau detector, replaced in r5): accepted, no longer used. */
	plateauSamples: number;
	plateauGrowth: number;
	/** H1/G2: two reported counts within this fraction are "the same"; also the naming tolerance. */
	plateauFlatness: number;
	/**
	 * R5 silent truncation: between two consecutive requests whose message list only grew, reported
	 * usage must grow by at least this fraction of the appended text's expected tokens (images excluded).
	 */
	silentShortfall: number;
	/** R5: appended text below this many expected tokens is too small to judge. */
	silentMinGrowth: number;
	/** R5: no growth at all after appending at least this many expected tokens is strong evidence. */
	silentZeroGrowthFloor: number;
	/** R5: below this growth ratio (and above silentShortfall) a sample is no evidence but cannot clear evidence. */
	silentMarginal: number;
	/** R5: a growth ratio below this, on an append of at least silentStrongGrowth tokens, is strong evidence. */
	silentStrongShortfall: number;
	silentStrongGrowth: number;
	/** R5: the "no more than the largest usage" rule needs this many clean samples for the model first. */
	silentSettledSamples: number;
	/** R5: weak evidence samples needed (one strong sample suffices). */
	silentSuspects: number;
	/** R5: weak evidence older than this many samples is forgotten. */
	silentEvidenceSpan: number;
	/** H3: clean requests near a learned limit before a re-probe, and confirmations that end probing. */
	probeAfterParsed: number;
	probeAfterUnparsed: number;
	probeConfirmations: number;
	/** H6: tokens for an image whose size cannot be read; budget share images may hold after a cut. */
	defaultImageTokens: number;
	imageShare: number;
	/** P4: notice when the request is within this fraction of high water (or one turn's growth). */
	noticeFraction: number;
	/** R5: false switches the pre-cut notice off entirely (nothing is sent, counted or moved). */
	notice: boolean;
	/** R5: context_search returns at most this many hits and this many characters. */
	searchMaxResults: number;
	searchMaxChars: number;
	/** P5: "fail" refuses to run while compaction.enabled is not false; "warn" only warns (tests). */
	onCompactionEnabled: "fail" | "warn";
	maxLengthContinuations: number;
	maxOverflowRetries: number;
	notesMaxChars: number;
	taskMaxChars: number;
	/** G1: retries per run after an output-limit or output-caused combined error. */
	maxOutputRetries: number;
	/** G1: the output step-down (error without a number) halves the request, never below this. */
	minOutputLimit: number;
	/** G3: true repeats the pre-cut notice on every request in the zone (round 2); false gives one per cut cycle. */
	noticeRepeats: boolean;
	/**
	 * G3: move Anthropic's cache breakpoint off the notice (round 2's surgery). Off by default: with one
	 * notice per cut cycle it saved 0.2-0.5% of request tokens (1.4-2.4% of input cost) in g3-notice-cache.
	 */
	noticeCacheSurgery: boolean;
	/** D2: a run prompt shorter than this (trimmed) keeps the pinned task and becomes the latest instruction. */
	shortPromptChars: number;
	/**
	 * P2 (E4 2026-10-14, standing instructions): carry user messages that left the window in the header,
	 * verbatim, so instructions survive cuts without the model copying them into its notes. null = off
	 * (r5 behaviour: the H5 pinned task and latest instruction only).
	 */
	pinUserMessages: PinUserMessagesOptions | null;
	/** D1: fault injection (tests only), a FaultConfig or a PENPI_FAULTS spec; also read from PENPI_FAULTS. */
	faults?: FaultConfig | string | null;
	/** D1: marks a production deployment (fault injection is refused); also PENPI_PRODUCTION=1 or the setting penpi.production. */
	production?: boolean;
	/** Environment for PENPI_FAULTS and PENPI_PRODUCTION (default process.env). */
	env?: Record<string, string | undefined>;
	log?: (line: string) => void;
	/** Shared across reloads so tests can observe the engine. */
	stats?: EngineStats;
}

export interface EngineStats {
	cuts: Array<{ seq: number; mode: string; where: string; omitted: number; before: number; after: number }>;
	/** P2b (pin on): per cut, the header size planned with (fixedAfter - base) and the header actually rendered. */
	headerPlans: Array<{ upper: number; planned: number; rendered: number; secondPass: boolean }>;
	/** P2b: times the rendered header exceeded the upper bound (expected 0). */
	headerBoundMisses: number;
	guardTrims: number;
	capped: number;
	overflowRetries: number;
	lengthContinuations: number;
	alignMismatches: number;
	cancelledCompactions: Record<string, number>;
	calibrationSamples: number[];
	sent: Array<{ estimate: number; ratio: number; budget: number }>;
	clampedOutput: number;
	handlerMs: number[];
	plateaus: Array<{ key: string; window: number }>;
	probes: Array<{ key: string; from: number; to: number }>;
	learnedWindows: Array<{ key: string; window: number; source: string; confirmations: number }>;
	outputRaised: Array<{ key: string; to: number }>;
	outputCeilings: Array<{ key: string; ceiling: number }>;
	notices: number;
	refused: boolean;
	capDecisions: number;
	imageEvictions: number;
	indexRebuilds: number;
	/** The limits resolved for the latest request (H8 reporting). */
	lastLimits?: {
		key: string;
		window: number;
		reason: string;
		declaredWindow: number;
		budget: number;
		high: number;
		low: number;
		reserve: number;
		maxOutput: number;
	};
	statusTexts: string[];
	/** G1: classified provider errors. */
	providerErrors: Array<{ key: string; class: ProviderErrorClass; rule: string; learned?: string }>;
	outputRetries: number;
	/** D1: injected faults (response number is 1-based over successful assistant responses). */
	faults: Array<{ response: number; kind: "overflow" | "output-limit" | "length" }>;
	faultsActive?: string;
	faultsRefused?: string;
	/** G2: answers produced from silently truncated input. */
	plateauReports: Array<{ key: string; window: number; turns: TruncatedTurn[] }>;
	limitResets: number;
}

/** G2: one answer the provider produced without part of its input. */
export interface TruncatedTurn {
	entryId?: string;
	/** 1-based count of assistant messages on the branch. */
	turn?: number;
	/** ISO time of the answer. */
	at: string;
	/** What the engine expected the provider to process, and what it reported. */
	expected: number;
	reported: number;
}

export function newStats(): EngineStats {
	return {
		cuts: [],
		headerPlans: [],
		headerBoundMisses: 0,
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
		plateaus: [],
		probes: [],
		learnedWindows: [],
		outputRaised: [],
		outputCeilings: [],
		notices: 0,
		refused: false,
		capDecisions: 0,
		imageEvictions: 0,
		indexRebuilds: 0,
		statusTexts: [],
		providerErrors: [],
		outputRetries: 0,
		faults: [],
		plateauReports: [],
		limitResets: 0,
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
	defaultMaxOutput: 16_384,
	implausibleOutputFraction: 0.75,
	limitOverrides: {},
	windowCeiling: 200_000,
	commandName: "penpi",
	calibrate: true,
	ratioFloor: 0.8,
	ratioCeiling: 6,
	plateauSamples: 3,
	plateauGrowth: 0.05,
	plateauFlatness: 0.02,
	silentShortfall: 0.25,
	silentMinGrowth: 256,
	silentZeroGrowthFloor: 64,
	silentMarginal: 0.5,
	silentStrongShortfall: 0.15,
	silentStrongGrowth: 1_000,
	silentSettledSamples: 5,
	silentSuspects: 2,
	silentEvidenceSpan: 30,
	probeAfterParsed: 16,
	probeAfterUnparsed: 8,
	probeConfirmations: 2,
	defaultImageTokens: 1_600,
	imageShare: 0.5,
	noticeFraction: 0.9,
	notice: true,
	searchMaxResults: 10,
	searchMaxChars: 4_000,
	onCompactionEnabled: "fail",
	maxLengthContinuations: 3,
	maxOverflowRetries: 3,
	notesMaxChars: 4_000,
	taskMaxChars: 2_000,
	maxOutputRetries: 3,
	minOutputLimit: 1_024,
	noticeRepeats: false,
	noticeCacheSurgery: false,
	shortPromptChars: 40,
	pinUserMessages: null,
};

/** customType of the engine's state entries (custom, never in context). */
export const STATE_TYPE = "context-engine";
/** customType of the window header in mode "a" (a context-only custom message, never persisted). */
export const HEADER_TYPE = "context-engine.window";
export const NOTICE_TYPE = "context-engine.notice";
export const NOTICE_MARKER = "[context-engine notice]";
export const CONTINUE_TYPE = "context-engine.continue";
export const NOTES_TOOL = "context_notes";
export const RECALL_TOOL = "context_recall";
/** R5: text search over the session's entries that are out of view (or all of them). */
export const SEARCH_TOOL = "context_search";
/** PENpi's own tool that searches earlier session files (named in the header only when it is active). */
export const TRANSCRIPT_SEARCH_TOOL = "search_transcript";

// ================================================================== estimation (H1, H6)

/**
 * Tokens per character class, fitted by least squares (relative error, classes weighted equally) on
 * 4,000-character chunks of 14 content classes counted with o200k_base and GLM-5.3-Flash. Class-level
 * real/estimate ratios with these weights: 0.85-1.12 (chars / 4 gives 0.60-2.95).
 * See /tmp/spike/tokenizer-density-model.json.
 */
const DENSITY = {
	cjk: 0.6693,
	base64: 0.6691,
	digit: 0.7624,
	punct: 0.6425,
	letter: 0.0739,
	wsRun: 1.4958,
	ws: 0.655,
	other: 0.7154,
};

function isBase64Char(c: number): boolean {
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;
}

function isCjk(c: number): boolean {
	return (
		(c >= 0x3000 && c <= 0x30ff) ||
		(c >= 0x3400 && c <= 0x9fff) ||
		(c >= 0xac00 && c <= 0xd7af) ||
		(c >= 0xff00 && c <= 0xffef)
	);
}

/** Estimated tokens of a text, from its character classes. */
export function textTokens(text: string): number {
	let tokens = 0;
	const n = text.length;
	let i = 0;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (isBase64Char(c)) {
			let j = i;
			let letters = 0;
			let digits = 0;
			let punct = 0;
			while (j < n) {
				const d = text.charCodeAt(j);
				if (!isBase64Char(d)) break;
				if (d >= 48 && d <= 57) digits++;
				else if (d === 43 || d === 47 || d === 61) punct++;
				else letters++;
				j++;
			}
			tokens +=
				j - i >= 48
					? (j - i) * DENSITY.base64
					: letters * DENSITY.letter + digits * DENSITY.digit + punct * DENSITY.punct;
			i = j;
			continue;
		}
		if (c === 32 || c === 9) {
			let j = i;
			while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
			tokens += j - i >= 2 ? DENSITY.wsRun : DENSITY.ws;
			i = j;
			continue;
		}
		if (c === 10 || c === 13) tokens += DENSITY.ws;
		else if (isCjk(c)) tokens += DENSITY.cjk;
		else if (c < 128) tokens += DENSITY.punct;
		else {
			tokens += DENSITY.other;
			if (c >= 0xd800 && c <= 0xdbff) i++;
		}
		i++;
	}
	return Math.max(Math.ceil(tokens), Math.ceil(n / 8));
}

/** Width and height from a base64 PNG, GIF or JPEG header. */
export function imageSize(data: string): { width: number; height: number } | undefined {
	try {
		const head = Buffer.from(data.slice(0, 44), "base64");
		if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
			return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
		}
		if (head.length >= 10 && head.toString("ascii", 0, 4) === "GIF8") {
			return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
		}
		if (head[0] === 0xff && head[1] === 0xd8) {
			const bytes = Buffer.from(data.slice(0, 87_384), "base64");
			let i = 2;
			while (i + 9 < bytes.length && bytes[i] === 0xff) {
				const marker = bytes[i + 1];
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
				}
				i += 2 + bytes.readUInt16BE(i + 2);
			}
		}
	} catch {}
	return undefined;
}

let defaultImageTokens = DEFAULTS.defaultImageTokens;

/** Estimated image tokens: Anthropic's width x height / 750, at most 1,600 after its resize. */
export function imageTokens(image: { data: string }): number {
	const size = imageSize(image.data);
	return size ? Math.max(85, Math.min(1_600, Math.ceil((size.width * size.height) / 750))) : defaultImageTokens;
}

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; data?: string };

function blocksTokens(content: unknown): number {
	if (typeof content === "string") return textTokens(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content as Block[]) {
		if (block.type === "text") tokens += textTokens(block.text ?? "");
		else if (block.type === "image") tokens += imageTokens(block as { data: string });
		else if (block.type === "thinking") tokens += textTokens(block.thinking ?? "");
		else if (block.type === "toolCall")
			tokens += textTokens(`${block.name} ${JSON.stringify(block.arguments ?? {})}`) + 8;
	}
	return tokens;
}

const tokenCache = new WeakMap<object, number>();

/** Estimated tokens of one message (cached per message object; session messages are immutable). */
export function messageTokens(message: AgentMessage): number {
	const cached = tokenCache.get(message);
	if (cached !== undefined) return cached;
	const m = message as Record<string, unknown> & { role: string };
	let tokens = 4;
	switch (m.role) {
		case "system": {
			tokens += blocksTokens(m.content);
			for (const section of Object.values((m.sections as Record<string, string | null>) ?? {})) {
				if (section) tokens += textTokens(section);
			}
			if (m.toolsAdded) tokens += textTokens(JSON.stringify(m.toolsAdded));
			if (m.toolsRemoved) tokens += textTokens(JSON.stringify(m.toolsRemoved));
			break;
		}
		case "toolResult":
			tokens += textTokens(String(m.toolName ?? "")) + blocksTokens(m.content);
			break;
		case "bashExecution":
			tokens += textTokens(`${m.command ?? ""}\n${m.output ?? ""}`);
			break;
		case "compactionSummary":
		case "branchSummary":
			tokens += textTokens(String(m.summary ?? "")) + 30;
			break;
		default:
			tokens += blocksTokens(m.content);
	}
	tokenCache.set(message, tokens);
	return tokens;
}

/**
 * R5 (fix): what a provider counts when this message is replayed. An assistant message with reasoning
 * only (no text, no tool call; in practice a turn that hit the output limit) is replayed without
 * content, and GLM-5.3-Flash via OpenRouter counted none of its reasoning (E4 glm-full B/s02: 16,234
 * expected, +27 reported). Its reasoning is left out; every other message counts as messageTokens.
 */
function replayedTokens(message: AgentMessage): number {
	const tokens = messageTokens(message);
	if (message.role !== "assistant") return tokens;
	const blocks = (message as AssistantMessage).content as unknown as Block[];
	if (blocks.some((b) => b.type === "toolCall" || (b.type === "text" && (b.text ?? "").trim().length > 0)))
		return tokens;
	return tokens - blocks.reduce((sum, b) => sum + (b.type === "thinking" ? textTokens(b.thinking ?? "") : 0), 0);
}

/** Estimated image tokens in one message (R5: images are left out of the silent-truncation evidence). */
function messageImageTokens(message: AgentMessage): number {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content as Block[]) if (block.type === "image") tokens += imageTokens(block as { data: string });
	return tokens;
}

/**
 * R5: identities of a request's messages (role, timestamp, custom type), without a trailing
 * request-only notice, and that notice's estimate. Two requests where the first's keys are a prefix
 * of the second's differ only by appended messages.
 */
function requestShape(messages: AgentMessage[]): { keys: string[]; noticeTokens: number } {
	const keys = messages.map((m) => {
		const r = m as { role: string; timestamp?: number; customType?: string };
		return `${r.role}:${r.timestamp ?? 0}:${r.customType ?? ""}`;
	});
	const last = messages.at(-1) as { role?: string; customType?: string } | undefined;
	if (last?.role === "custom" && last.customType === NOTICE_TYPE) {
		keys.pop();
		return { keys, noticeTokens: messageTokens(messages.at(-1)!) };
	}
	return { keys, noticeTokens: 0 };
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((block) => {
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

// ================================================================== unit caps (E4, H6)

/** A frozen cap decision for one session entry: keep `chars` of its text, replace these images. */
export interface CapDecision {
	chars?: number;
	dropImages?: number[];
	/** b modes: the cap was written into the session as a context_edit; do not apply it again. */
	materialized?: boolean;
}

function cappable(message: AgentMessage): boolean {
	if (message.role === "custom") return !message.customType.startsWith(STATE_TYPE);
	return message.role === "toolResult" || message.role === "user";
}

function contentBlocks(message: AgentMessage): Array<TextContent | ImageContent> {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Array<TextContent | ImageContent>) : [];
}

/** Decide a cap for a unit over `maxUnit` provider tokens; text and images share the unit budget. */
function decideCap(message: AgentMessage, maxUnit: number, ratio: number): CapDecision | undefined {
	if (!cappable(message)) return undefined;
	const blocks = contentBlocks(message);
	const text = blocks
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const textCost = textTokens(text) * ratio;
	const images = blocks.flatMap((b, index) => (b.type === "image" ? [{ index, cost: imageTokens(b) * ratio }] : []));
	const imageCost = images.reduce((sum, image) => sum + image.cost, 0);
	if (textCost + imageCost <= maxUnit) return undefined;
	const decision: CapDecision = {};
	const textBudget = images.length > 0 ? Math.max(maxUnit * 0.5, maxUnit - imageCost) : maxUnit;
	let textUsed = textCost;
	if (textCost > textBudget) {
		decision.chars = Math.max(1_000, Math.floor((text.length * textBudget) / textCost));
		textUsed = textBudget;
	}
	let room = maxUnit - textUsed;
	const drop: number[] = [];
	for (const image of [...images].reverse()) {
		if (image.cost <= room) room -= image.cost;
		else drop.push(image.index);
	}
	if (drop.length > 0) decision.dropImages = drop.sort((a, b) => a - b);
	return decision.chars !== undefined || decision.dropImages ? decision : undefined;
}

/** Render a capped copy of `message` (head/tail text and image placeholders, all pointing at the entry). */
function applyCap(message: AgentMessage, entryId: string, decision: CapDecision): AgentMessage {
	const blocks = contentBlocks(message);
	const imageCount = blocks.filter((b) => b.type === "image").length;
	const out: Array<TextContent | ImageContent> = [];
	let textDone = false;
	let imageNumber = 0;
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (block.type === "text") {
			if (decision.chars === undefined) {
				out.push(block);
				continue;
			}
			if (textDone) continue;
			textDone = true;
			const text = blocks
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			const head = Math.floor(decision.chars * 0.75);
			const tail = decision.chars - head;
			const marker =
				`\n\n[context-engine: characters ${head}-${text.length - tail} of ${text.length} are not shown here. ` +
				`The full content is kept verbatim in session entry ${entryId}; read it with ` +
				`${RECALL_TOOL}({ "entry": "${entryId}", "offset": ${head} }).]\n\n`;
			out.push({ type: "text", text: text.slice(0, head) + marker + text.slice(text.length - tail) });
			continue;
		}
		imageNumber++;
		if (decision.dropImages?.includes(index)) {
			const size = imageSize(block.data);
			out.push({
				type: "text",
				text:
					`[image ${imageNumber} of ${imageCount}${size ? ` (${size.width}x${size.height})` : ""} is not shown here to keep the request within the model's limit; ` +
					`it is kept in session entry ${entryId}: ${RECALL_TOOL}({ "entry": "${entryId}", "image": ${index} })]`,
			});
		} else out.push(block);
	}
	return { ...message, content: out } as AgentMessage;
}

// ================================================================== overflow parsing (E5)

const NUMBER = "([\\d,]+)";
const LIMIT_PATTERNS = [
	`>\\s*${NUMBER}\\s*maximum`,
	`maximum context length is ${NUMBER}`,
	`maximum context length of ${NUMBER}`,
	`maximum context length \\(${NUMBER}\\)`,
	`maximum context length: ${NUMBER}`,
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
	`messages resulted in ${NUMBER} tokens`,
	`your request has ${NUMBER} input tokens`,
	`too long: ${NUMBER}`,
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

// ================================================================== provider error classes (G1)

/**
 * G1: what a provider error means for the engine.
 *   output-limit            the request asked for more output than the model may produce
 *   context-overflow        the input alone does not fit the context (E5: the window shrinks)
 *   combined-output-caused  input + requested output exceed the context, but the input alone fits
 *                           with room to answer: lower the output, never the window
 *   unknown                 anything else (rate limits, parameter errors, ...)
 */
export type ProviderErrorClass = "output-limit" | "context-overflow" | "combined-output-caused" | "unknown";

export interface ProviderErrorInfo {
	class: ProviderErrorClass;
	/** Which rule matched. */
	rule: string;
	/** The model's output ceiling, when the error states it. */
	outputLimit?: number;
	/** Output tokens the rejected request asked for, when stated. */
	requestedOutput?: number;
	/** Input tokens the provider counted, when stated. */
	input?: number;
	/** The context window the error states. */
	contextLimit?: number;
}

/** A combined error is output-caused only if the input leaves at least this much room to answer. */
export const MIN_OUTPUT_ROOM = 1_024;

const toNumber = (text: string | undefined): number | undefined =>
	text === undefined ? undefined : Number(text.replace(/,/g, ""));

const RATE_LIMIT_PATTERN = /rate.?limit|tokens per min|\(TPM\)|requests per min|too many requests|throttl/i;

const OUTPUT_LIMIT_RULES: Array<{
	rule: string;
	pattern: RegExp;
	read: (m: RegExpMatchArray) => Partial<ProviderErrorInfo>;
}> = [
	{
		// Anthropic direct, Vertex and Bedrock InvokeModel (Anthropic body).
		rule: "anthropic max_tokens > maximum",
		pattern: /max_tokens:\s*([\d,]+)\s*>\s*([\d,]+),?\s*which is the maximum allowed number of output tokens/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), outputLimit: toNumber(m[2]) }),
	},
	{
		// OpenAI chat completions (max_tokens, and max_completion_tokens for reasoning models).
		rule: "openai is too large / supports at most",
		pattern:
			/(?:max_tokens|max_completion_tokens|max_output_tokens) is too large:\s*([\d,]+)\.?\s*This model supports at most ([\d,]+) completion tokens/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), outputLimit: toNumber(m[2]) }),
	},
	{
		// OpenAI parameter validation (Responses max_output_tokens).
		rule: "openai integer above maximum value",
		pattern:
			/'(?:max_tokens|max_completion_tokens|max_output_tokens)':\s*integer above maximum value\.\s*Expected a value <=\s*([\d,]+),\s*but got ([\d,]+)/i,
		read: (m) => ({ outputLimit: toNumber(m[1]), requestedOutput: toNumber(m[2]) }),
	},
	{
		// Bedrock Converse.
		rule: "bedrock exceeds the model limit",
		pattern: /maximum tokens you requested exceeds the model limit of ([\d,]+)/i,
		read: (m) => ({ outputLimit: toNumber(m[1]) }),
	},
	{
		// Gemini (Vertex and the Gemini API).
		rule: "gemini maxOutputTokens supported range",
		pattern:
			/maxOutputTokens value of ([\d,]+) but the supported range is from \d+ \(inclusive\) to ([\d,]+) \(exclusive\)/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), outputLimit: (toNumber(m[2]) ?? 1) - 1 }),
	},
];

const COMBINED_RULES: Array<{
	rule: string;
	pattern: RegExp;
	read: (m: RegExpMatchArray) => { input?: number; requestedOutput?: number; contextLimit?: number };
}> = [
	{
		rule: "anthropic input + max_tokens > context limit",
		pattern: /input length and `?max_tokens`? exceed context limit:\s*([\d,]+)\s*\+\s*([\d,]+)\s*>\s*([\d,]+)/i,
		read: (m) => ({ input: toNumber(m[1]), requestedOutput: toNumber(m[2]), contextLimit: toNumber(m[3]) }),
	},
	{
		rule: "vllm max_tokens too large for the remaining context",
		pattern:
			/is too large:\s*([\d,]+)\.\s*This model's maximum context length is ([\d,]+) tokens and your request has ([\d,]+) input tokens/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), contextLimit: toNumber(m[2]), input: toNumber(m[3]) }),
	},
	{
		// OpenAI chat completions, OpenAI legacy completions, DeepSeek, vLLM <= 0.8, Groq-style.
		rule: "openai messages + completion > context",
		pattern:
			/maximum context length is ([\d,]+) tokens[.,]?\s*however,? you requested (?:about )?[\d,]+ tokens\s*\(([\d,]+) in (?:the messages|your prompt)[;,]\s*([\d,]+) (?:in|for) the completion\)/i,
		read: (m) => ({ contextLimit: toNumber(m[1]), input: toNumber(m[2]), requestedOutput: toNumber(m[3]) }),
	},
	{
		// OpenRouter: "(A of text input, T of tool input, B in the output)".
		rule: "openrouter input parts + output > context",
		pattern:
			/maximum context length is ([\d,]+) tokens\.?\s*however,? you requested about [\d,]+ tokens\s*\(([^)]*?)([\d,]+) in the output\)/i,
		read: (m) => ({
			contextLimit: toNumber(m[1]),
			input: [...m[2].matchAll(/([\d,]+) of [a-z ]*input/gi)].reduce(
				(sum, part) => sum + (toNumber(part[1]) ?? 0),
				0,
			),
			requestedOutput: toNumber(m[3]),
		}),
	},
	{
		// Hugging Face TGI (and Together AI deployments of it).
		rule: "tgi inputs + max_new_tokens",
		pattern:
			/`inputs` tokens \+ `max_new_tokens` must be <=\s*([\d,]+)\.\s*Given:\s*([\d,]+) `inputs` tokens and ([\d,]+) `max_new_tokens`/i,
		read: (m) => ({ contextLimit: toNumber(m[1]), input: toNumber(m[2]), requestedOutput: toNumber(m[3]) }),
	},
];

/** Output-limit wording without numbers (step down). Must not mention the context or the input. */
const GENERIC_OUTPUT_LIMIT =
	/\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|max_new_tokens|max(?:imum)? tokens)\b[^.\n]{0,60}\b(?:too large|exceeds?|above|greater than|not less or equal|is limited)/i;
const MENTIONS_INPUT = /context|input|prompt/i;

/**
 * G1: classify a provider error before relying on Pi's isContextOverflow, which reads several
 * combined (input + output) errors as overflow. Order: rate limits, explicit output limits,
 * combined errors (output-caused when the input alone fits with room), context overflow (the
 * engine's patterns and Pi's), output limits stated without numbers, unknown.
 */
export function classifyProviderError(errorMessage: string | undefined, provider?: string): ProviderErrorInfo {
	if (!errorMessage) return { class: "unknown", rule: "no message" };
	const text = errorMessage.replace(/[‘’]/g, "'");
	if (RATE_LIMIT_PATTERN.test(text)) return { class: "unknown", rule: "rate limit" };
	for (const { rule, pattern, read } of OUTPUT_LIMIT_RULES) {
		const match = text.match(pattern);
		if (match) return { class: "output-limit", rule, ...read(match) };
	}
	for (const { rule, pattern, read } of COMBINED_RULES) {
		const match = text.match(pattern);
		if (!match) continue;
		const parts = read(match);
		if (parts.input !== undefined && parts.contextLimit !== undefined) {
			const fits = parts.input + MIN_OUTPUT_ROOM <= parts.contextLimit;
			return { class: fits ? "combined-output-caused" : "context-overflow", rule, ...parts };
		}
	}
	const probe = {
		role: "assistant",
		stopReason: "error",
		errorMessage: text,
		provider,
		content: [],
	} as unknown as AssistantMessage;
	const { limit, requested } = parseOverflow(text);
	if (
		isContextOverflow(probe) ||
		/prompt is too long|input is too long|exceed(?:s|ed)? (?:the )?(?:maximum )?context/i.test(text)
	) {
		return { class: "context-overflow", rule: "context overflow", contextLimit: limit, input: requested };
	}
	if (GENERIC_OUTPUT_LIMIT.test(text) && !MENTIONS_INPUT.test(text)) {
		return { class: "output-limit", rule: "output limit without numbers" };
	}
	return { class: "unknown", rule: "no rule" };
}

// ================================================================== fault injection (D1)

/** When a fault fires: every Nth assistant response, at listed response numbers, or with a probability. */
export interface FaultRule {
	every?: number;
	at?: number[];
	probability?: number;
}

export interface FaultConfig {
	overflow?: FaultRule;
	outputLimit?: FaultRule;
	length?: FaultRule;
	seed?: number;
}

/** D1: fault-injection switch (JSON, or "overflow=every:7;output-limit=p:0.1;length=at:3,9;seed=42"). */
export const FAULTS_ENV = "PENPI_FAULTS";
/** D1: marks the deployment as production ("1", "true" or "yes"); fault injection is then refused. */
export const PRODUCTION_ENV = "PENPI_PRODUCTION";

export function parseFaultSpec(spec: string): FaultConfig {
	const trimmed = spec.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed) as FaultConfig;
	const config: FaultConfig = {};
	for (const part of trimmed.split(";").map((p) => p.trim())) {
		if (!part) continue;
		const [name, value = ""] = part.split("=").map((p) => p.trim());
		if (name === "seed") {
			config.seed = Number(value);
			continue;
		}
		const key = (
			{ overflow: "overflow", "output-limit": "outputLimit", output: "outputLimit", length: "length" } as const
		)[name as "overflow"];
		if (!key) throw new Error(`${FAULTS_ENV}: unknown fault "${name}" (overflow, output-limit, length)`);
		const [how, args = ""] = value.split(":");
		const rule: FaultRule = {};
		if (how === "every") rule.every = Number(args);
		else if (how === "at") rule.at = args.split(",").map(Number);
		else if (how === "p") rule.probability = Number(args);
		else throw new Error(`${FAULTS_ENV}: "${part}": use every:N, at:A,B or p:X`);
		config[key] = rule;
	}
	return config;
}

/** Deterministic generator for probabilistic faults. */
function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function describeFaults(config: FaultConfig): string {
	const rule = (r: FaultRule) =>
		[
			r.every ? `every ${r.every}` : "",
			r.at?.length ? `at ${r.at.join(",")}` : "",
			r.probability ? `p ${r.probability}` : "",
		]
			.filter(Boolean)
			.join(" ");
	return [
		config.overflow ? `overflow ${rule(config.overflow)}` : "",
		config.outputLimit ? `output-limit ${rule(config.outputLimit)}` : "",
		config.length ? `length ${rule(config.length)}` : "",
		config.seed !== undefined ? `seed ${config.seed}` : "",
	]
		.filter(Boolean)
		.join("; ");
}

/**
 * P4: Pi's Anthropic payload puts the prompt-cache breakpoint on the last block of the last user
 * message, which is the request-only notice when one is present. Move it to the block before, so the
 * cache entry written by this request is a prefix of the next request. Returns the payload unchanged
 * (same object) when there is nothing to move.
 */
export function moveCacheBreakpointOffNotice(payload: unknown): unknown {
	const messages = (payload as { messages?: unknown })?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return payload;
	const last = messages.at(-1) as { content?: unknown };
	if (!Array.isArray(last?.content)) return payload;
	const blocks = last.content as Array<Record<string, unknown>>;
	const at = blocks.findIndex(
		(b) => b?.type === "text" && typeof b.text === "string" && b.text.includes(NOTICE_MARKER),
	);
	if (at < 0 || !blocks[at].cache_control) return payload;
	const content = blocks.map((b) => ({ ...b }));
	const breakpoint = content[at].cache_control;
	delete content[at].cache_control;
	const nextMessages = [...messages];
	if (at > 0) content[at - 1].cache_control = breakpoint;
	else if (messages.length > 1) {
		const previous = messages.at(-2) as { content?: unknown };
		if (Array.isArray(previous?.content) && previous.content.length > 0) {
			const previousBlocks = (previous.content as Array<Record<string, unknown>>).map((b) => ({ ...b }));
			previousBlocks[previousBlocks.length - 1].cache_control = breakpoint;
			nextMessages[nextMessages.length - 2] = { ...previous, content: previousBlocks };
		}
	}
	nextMessages[nextMessages.length - 1] = { ...last, content };
	return { ...(payload as object), messages: nextMessages };
}

function contributesMessages(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/** The context messages one entry contributes (mirrors Pi's sessionEntryToContextMessages for non-compaction entries). */
function entryMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") return entry.message ? [entry.message as AgentMessage] : [];
	if (entry.type === "custom_message") {
		return [
			{
				role: "custom",
				customType: entry.customType,
				content: entry.content ?? [],
				display: entry.display,
				details: entry.details,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [
			{
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		];
	}
	return [];
}

// ================================================================== state

interface CutState {
	firstKeptEntryId: string;
	seq: number;
	header: string;
	/** When the cut was made (ms): the header's timestamp, so Pi's estimate ignores pre-cut usage. */
	at?: number;
}

interface LearnedWindow {
	/** Current believed window (above `base` while a re-probe is running). */
	window: number;
	/** The limit the evidence supports. */
	base: number;
	/** The window from metadata or the default, the ceiling for re-probes. */
	declared: number;
	source: "parsed" | "unparsed" | "plateau";
	/** Failed re-probes at the same limit. */
	confirmations: number;
	cleanNear: number;
	probeAfter: number;
	/**
	 * H8: a successful request above this many provider tokens (the parsed limit, or the rejected size
	 * when unparsed) is the evidence that retires the record. Reaching the declared window does not.
	 */
	evidenceAbove?: number;
	/** G2: plateau windows are kept for this session only (never exported, never re-probed). */
	scope?: "session";
	/** G2: answers produced from truncated input when the plateau was detected. */
	truncatedTurns?: TruncatedTurn[];
}

interface ModelState {
	ratio: number;
	samples: number;
	history: Array<{ estimate: number; reported: number; ratio: number }>;
	/** G2: recent samples with their answer's timestamp, to name truncated turns. */
	recent: Array<{ at: number; expected: number; reported: number; ratio: number; suspect?: string }>;
	/** R5: the previous successful sample (send sequence number and reported usage). */
	lastSample?: { seq: number; reported: number };
	/** R5: the largest usage reported by a sample that was not quarantined. */
	maxReported: number;
	/** R5: the expectation of the sample that set maxReported (a repeat of the same request is no evidence). */
	maxExpected?: number;
	/** R5: quarantined samples (evidence of silent truncation), with the sample count when seen. */
	suspects: Array<{ reported: number; at: number; sample: number; why: string }>;
	learned?: LearnedWindow;
	output: {
		ceiling?: number;
		/** "length": repeated length stops (H4); "error": an output-limit error (G1). */
		ceilingSource?: "length" | "error";
		raised?: number;
		/** G1: the context an output-caused combined error stated; bounds output room only. */
		contextLimit?: number;
		stops: number[];
	};
	warnedPlateau?: boolean;
}

interface Limits {
	/** Effective planning window: min(learned, override ?? min(declared or default, ceiling)). */
	window: number;
	/** Planning window before learned limits; the ceiling for re-probes. */
	metadataWindow: number;
	/** The window the provider is believed to accept (no ceiling); bounds the output a request may ask for. */
	hardWindow: number;
	declaredWindow: number;
	declaredMax: number;
	maxOutput: number;
	maxOutputReason: string;
	/** Output reserve = min(maxOutput, outputReserveFraction x window). */
	reserve: number;
	/** Input budget = window - reserve. */
	budget: number;
	high: number;
	low: number;
	maxUnit: number;
	verified: boolean;
	plausibleMax: boolean;
	/** Why the window is what it is: metadata, metadata(unverified), override, ceiling, default(...), learned(...). */
	reason: string;
	source: string;
	ceiling: number | undefined;
	key: string;
	state: ModelState;
}

/** One model-visible message with the entry that owns it. */
interface Item {
	entryId: string;
	message: AgentMessage;
	out: AgentMessage;
	tokens: number;
	startable: boolean;
	system: boolean;
}

/** Mode a: the window from the cut onward, kept up to date from the leaf (H7). */
interface WindowIndex {
	leafId: string | null;
	items: Item[];
	total: number;
	cut?: CutState;
	checkpoint?: AgentMessage;
	checkpointTokens: number;
	header?: AgentMessage;
	headerTokens: number;
	recent: number[];
	/** G3: the pre-cut notice was given in this cut cycle (re-armed by every cut and by a rebuild). */
	noticeGiven?: boolean;
}

/** 200000 -> "200k", 1048575 -> "1.05M". */
function kTokens(value: number): string {
	if (value >= 999_500) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return `${Math.round(value)}`;
}

export function createContextEngine(overrides: Partial<EngineOptions> = {}): ExtensionFactory {
	const opts: EngineOptions = { ...DEFAULTS, ...overrides };
	const stats = opts.stats ?? newStats();
	const log = (line: string) => opts.log?.(`[${opts.mode}] ${line}`);
	defaultImageTokens = opts.defaultImageTokens;

	// D1: fault injection is off unless asked for, and refused in production.
	const env = opts.env ?? process.env;
	const productionReason =
		opts.production === true
			? "the production option"
			: /^(1|true|yes)$/i.test(env[PRODUCTION_ENV] ?? "")
				? `${PRODUCTION_ENV}=${env[PRODUCTION_ENV]}`
				: undefined;
	const faultRequest = opts.faults ?? env[FAULTS_ENV] ?? undefined;
	let faults: FaultConfig | undefined;
	let faultsRefused: string | undefined;
	if (faultRequest) {
		if (productionReason) faultsRefused = productionReason;
		else faults = typeof faultRequest === "string" ? parseFaultSpec(faultRequest) : faultRequest;
	}
	const faultBanner = () =>
		faults
			? `FAULT INJECTION ACTIVE (${describeFaults(faults)}): the engine turns some successful responses into errors or length stops. Never use this in production.`
			: faultsRefused
				? `FAULT INJECTION REFUSED: ${faultsRefused} marks this deployment as production; ${opts.faults ? "the faults option" : FAULTS_ENV} is ignored.`
				: undefined;
	if (faults) stats.faultsActive = describeFaults(faults);
	if (faultsRefused) stats.faultsRefused = faultsRefused;
	// R5: a refusal known now (environment or option) is announced now. ACTIVE is announced only at
	// session start, after the settings guard, so a refused switch never prints ACTIVE.
	if (faultsRefused) {
		log(faultBanner()!);
		console.warn(`[context-engine] ${faultBanner()}`);
	}

	return (pi: ExtensionAPI) => {
		const models = new Map<string, ModelState>();
		const decisions = new Map<string, CapDecision>();
		let pendingDecisions: Record<string, CapDecision> = {};
		const outCache = new Map<string, { message: AgentMessage; out: AgentMessage }>();
		/**
		 * The request just sent. R5: `seq` numbers every request; `appendOnly` says its message list extends
		 * the previous request's (request-only notice tails excluded), `appendedText` is the estimate of the
		 * appended messages without images, `noticeDrop` the estimate of the previous request's notice,
		 * `afterLengthStop` that the appended messages include an answer cut at the output limit.
		 */
		let lastSent:
			| {
					estimate: number;
					key: string;
					seq: number;
					appendOnly: boolean;
					appendedText: number;
					noticeDrop: number;
					afterLengthStop: boolean;
			  }
			| undefined;
		let sendSeq = 0;
		/** P2: the window of the latest resolved limits (sizes the user-message pin). */
		let lastWindow = 0;
		let sentShape: { keys: string[]; noticeTokens: number } | undefined;
		let lastOutputLimit: { sent?: number; lowered: boolean } | undefined;
		let overflowRetries = 0;
		let lengthContinuations = 0;
		let hintedThisRun = false;
		let seqCache = 0;
		let index: WindowIndex | undefined;
		let refused = false;
		let lastRequestTokens: number | undefined;
		// G1
		let outputRetries = 0;
		let outputCapOnce: number | undefined;
		let lastOutputProgress = true;
		// G2: a plateau found at message_end is reported at turn_end, once the answer has an entry id.
		let pendingPlateau: { key: string; window: number; max: number; samples: ModelState["recent"] } | undefined;
		// D1
		let responseCount = 0;
		const faultRandom = rng(faults?.seed ?? 1);

		// ---------------------------------------------------------------- per-model state (H2)
		function modelState(key: string): ModelState {
			let state = models.get(key);
			if (!state) {
				// Unknown model: the densest known ratio is the safe prior (it under-sends until learned).
				const known = [...models.values()].filter((m) => m.samples > 0).map((m) => m.ratio);
				state = {
					ratio: Math.max(1, ...known),
					samples: 0,
					history: [],
					recent: [],
					maxReported: 0,
					suspects: [],
					output: { stops: [] },
				};
				models.set(key, state);
			}
			return state;
		}

		function snapshot(key: string): Record<string, unknown> {
			const s = modelState(key);
			return {
				kind: "model",
				key,
				ratio: s.ratio,
				samples: s.samples,
				learned: s.learned,
				output: {
					ceiling: s.output.ceiling,
					ceilingSource: s.output.ceilingSource,
					raised: s.output.raised,
					contextLimit: s.output.contextLimit,
				},
			};
		}

		function persistModel(key: string): void {
			pi.appendEntry(STATE_TYPE, snapshot(key));
		}

		function clampRatio(value: number): number {
			return Math.min(opts.ratioCeiling, Math.max(opts.ratioFloor, value));
		}

		function ratioFor(key: string): number {
			return opts.calibrate ? clampRatio(modelState(key).ratio) : 1;
		}

		function loadState(ctx: ExtensionContext): void {
			models.clear();
			decisions.clear();
			outCache.clear();
			index = undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
				const data = entry.data as Record<string, unknown> & { kind?: string };
				if (data.kind === "model" && typeof data.key === "string") {
					const learned = data.learned as LearnedWindow | undefined;
					const output = (data.output as ModelState["output"] | undefined) ?? { stops: [] };
					models.set(data.key, {
						ratio: Number(data.ratio ?? 1),
						samples: Number(data.samples ?? 0),
						history: [],
						recent: [],
						maxReported: 0,
						suspects: [],
						learned: learned ? { ...learned } : undefined,
						output: {
							ceiling: output.ceiling,
							ceilingSource: output.ceilingSource,
							raised: output.raised,
							contextLimit: output.contextLimit,
							stops: [],
						},
					});
				}
				if (data.kind === "caps" && data.decisions) {
					for (const [id, decision] of Object.entries(data.decisions as Record<string, CapDecision>))
						decisions.set(id, decision);
				}
			}
			seqCache = readCut(ctx.sessionManager.getBranch())?.seq ?? 0;
			log(
				`state loaded models=${JSON.stringify([...models.entries()].map(([k, v]) => [k, +v.ratio.toFixed(3), v.samples, v.learned?.window]))} caps=${decisions.size} seq=${seqCache}`,
			);
		}

		/** Latest cut on the branch: a custom entry (mode a) or an engine compaction (b-compaction). */
		function readCut(branch: SessionEntry[]): CutState | undefined {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "custom" && entry.customType === STATE_TYPE) {
					const data = entry.data as { kind?: string } & Partial<CutState>;
					if (data.kind === "cut" && data.firstKeptEntryId) {
						return {
							firstKeptEntryId: data.firstKeptEntryId,
							seq: data.seq ?? 0,
							header: data.header ?? "",
							at: Date.parse(entry.timestamp) + 1,
						};
					}
				}
				if (entry.type === "compaction") {
					const details = entry.details as { engine?: string; seq?: number } | undefined;
					if (details?.engine === STATE_TYPE) {
						return {
							firstKeptEntryId: entry.firstKeptEntryId,
							seq: details.seq ?? 0,
							header: entry.summary,
							at: Date.parse(entry.timestamp) + 1,
						};
					}
				}
			}
			return undefined;
		}

		// ---------------------------------------------------------------- limits (E7, H3, H4)
		const perModel = { ...opts.limitOverrides, ...(opts.modelLimits ?? {}) };
		const ceiling = opts.windowCeiling && opts.windowCeiling > 0 ? opts.windowCeiling : undefined;

		function resolveLimits(ctx: ExtensionContext): Limits {
			const model = ctx.model;
			const key = model ? `${model.provider}/${model.id}` : "?";
			const state = modelState(key);
			const override = perModel[key];
			const registered = model ? ctx.modelRegistry.find(model.provider, model.id) : undefined;
			const declaredWindow = model && model.contextWindow > 0 ? model.contextWindow : 0;
			const declaredMax = model && model.maxTokens > 0 ? model.maxTokens : 0;
			const plausibleMax =
				declaredMax > 0 && declaredWindow > 0 && declaredMax <= opts.implausibleOutputFraction * declaredWindow;
			const verified = !!registered && declaredWindow > 0 && plausibleMax;
			// 1. What the model (or the user) says.
			let base: number;
			let reason: string;
			if (override?.contextWindow) {
				base = override.contextWindow;
				reason = "override";
			} else if (declaredWindow > 0 && registered) {
				base = declaredWindow;
				reason = verified ? "metadata" : "metadata(unverified)";
			} else if (declaredWindow > 0) {
				base = Math.min(declaredWindow, opts.defaultWindow);
				reason = "default(unregistered)";
			} else {
				base = opts.defaultWindow;
				reason = "default(missing)";
			}
			// 2. H8: the decided ceiling caps planning, unless a per-model override set the window explicitly.
			let planned = base;
			if (ceiling && !override?.contextWindow && base > ceiling) {
				planned = ceiling;
				reason = "ceiling";
			}
			// 3. Evidence: a learned (smaller) limit wins over both.
			let window = planned;
			let hardWindow = base;
			if (state.learned && state.learned.window < window) {
				window = state.learned.window;
				reason = `learned(${state.learned.source})`;
			}
			if (state.learned && state.learned.window < hardWindow) hardWindow = state.learned.window;
			// G1: an output-caused combined error bounds the room for output, never the planning window.
			if (state.output.contextLimit && state.output.contextLimit < hardWindow)
				hardWindow = state.output.contextLimit;
			// Output: override, plausible metadata, or the default (capped at half the planning window).
			let maxOutput: number;
			let maxOutputReason: string;
			if (override?.maxTokens) {
				maxOutput = override.maxTokens;
				maxOutputReason = "override";
			} else if (plausibleMax) {
				maxOutput = declaredMax;
				maxOutputReason = "metadata";
			} else {
				maxOutput = Math.min(opts.defaultMaxOutput, Math.floor(window / 2));
				maxOutputReason = declaredMax > 0 ? "default (declared max is implausible)" : "default (no declared max)";
			}
			if (state.output.raised && state.output.raised > maxOutput) {
				maxOutput = Math.min(state.output.raised, Math.floor(hardWindow / 2));
				maxOutputReason += " +raised after a clamp-caused length stop";
			}
			if (state.output.ceiling && state.output.ceiling < maxOutput) {
				maxOutput = state.output.ceiling;
				maxOutputReason +=
					state.output.ceilingSource === "error"
						? " +provider ceiling learned from an output-limit error"
						: " +provider ceiling learned from length stops";
			}
			const reserve = Math.min(maxOutput, Math.floor(window * opts.outputReserveFraction));
			const budget = window - reserve;
			lastWindow = window;
			return {
				window,
				metadataWindow: planned,
				hardWindow,
				declaredWindow,
				declaredMax,
				maxOutput,
				maxOutputReason,
				reserve,
				budget,
				high: opts.highWater * budget,
				low: opts.lowWater * budget,
				maxUnit: opts.maxUnitFraction * budget,
				verified,
				plausibleMax,
				reason,
				source: reason,
				ceiling,
				key,
				state,
			};
		}

		function maxUnitTokens(limits: Limits): number {
			return opts.maxUnitFraction * limits.budget;
		}

		// ---------------------------------------------------------------- header (E8, H5)
		/**
		 * H5 + D2: the pinned task is the prompt of the latest run that was not short; a short run prompt
		 * ("now do the tests too") is carried as the latest instruction until the next long prompt.
		 */
		function pinned(branch: SessionEntry[]): {
			task: string;
			notes: string;
			latest: string;
			explicit: boolean;
			noteTask: string;
		} {
			let task = "";
			let noteTask = "";
			let notes = "";
			let latest = "";
			let lastUser = "";
			for (const entry of branch) {
				if (entry.type === "custom" && entry.customType === STATE_TYPE) {
					const data = entry.data as { kind?: string; prompt?: string };
					if (data.kind === "run" && data.prompt) {
						task = data.prompt;
						noteTask = "";
						latest = "";
					}
					if (data.kind === "latest" && data.prompt) latest = data.prompt;
					continue;
				}
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (message.role === "user") lastUser = textOfContent(message.content).slice(0, opts.taskMaxChars);
				if (message.role === "toolResult" && message.toolName === NOTES_TOOL && !message.isError) {
					const details = message.details as { notes?: string; task?: string } | undefined;
					if (details?.notes !== undefined) notes = details.notes;
					if (details?.task) {
						task = details.task;
						noteTask = details.task;
					}
				}
			}
			return { task: task || lastUser, notes, latest, explicit: task !== "", noteTask };
		}

		/** R5: whether a tool is declared to the model (the header and notices name only those). */
		function hasTool(name: string): boolean {
			try {
				return pi.getActiveTools().includes(name);
			} catch {
				return name === NOTES_TOOL || name === RECALL_TOOL || name === SEARCH_TOOL;
			}
		}

		/** R5: the header's guide to the recovery tools, naming only active ones. */
		function toolGuide(): string {
			const parts: string[] = [];
			if (hasTool(SEARCH_TOOL)) parts.push(`${SEARCH_TOOL} finds text in messages that left your context`);
			if (hasTool(RECALL_TOOL)) parts.push(`${RECALL_TOOL} reads any entry by id`);
			if (hasTool(TRANSCRIPT_SEARCH_TOOL)) parts.push(`${TRANSCRIPT_SEARCH_TOOL} searches earlier sessions`);
			let guide = parts.length > 0 ? ` ${parts.join("; ")}.` : "";
			if (hasTool(NOTES_TOOL))
				guide += ` Keep your plan and open threads in ${NOTES_TOOL}; they are carried into every window.`;
			return guide;
		}

		/**
		 * P2: user messages that left the window (entries before firstKeptEntryId), oldest first, verbatim.
		 * Over the cap, the middle goes first, oldest first: a verbatim message becomes a one-line pointer,
		 * then consecutive pointers become one range line. The first protectFirst messages and the newest
		 * carried message (the run's prompt once it has left the window: the H5 task) go last. A message
		 * longer than longMessageChars (a paste) is always a pointer. P2b: an image block is carried as an
		 * "[image: <mime>]" marker in place; a message with images and no text is carried as an image line.
		 */
		type Carried = { id: string; text: string; images: string[]; mode: "verbatim" | "pointer" | "range" | "image" };

		function pinCarried(branch: SessionEntry[], firstKeptEntryId: string): Carried[] {
			const pin = opts.pinUserMessages;
			if (!pin) return [];
			const carried: Carried[] = [];
			for (const entry of branch) {
				if (entry.id === firstKeptEntryId) break;
				if (entry.type !== "message" || entry.message.role !== "user") continue;
				const content = entry.message.content as unknown;
				const blocks: Block[] =
					typeof content === "string"
						? [{ type: "text", text: content }]
						: Array.isArray(content)
							? (content as Block[])
							: [];
				const images = blocks
					.filter((b) => b.type === "image")
					.map((b) => (b as { mimeType?: string }).mimeType ?? "unknown");
				const hasText = blocks.some((b) => b.type === "text" && (b.text ?? "").trim().length > 0);
				if (!hasText && images.length === 0) continue;
				const text = blocks
					.map((b) =>
						b.type === "text"
							? (b.text ?? "")
							: b.type === "image"
								? `[image: ${(b as { mimeType?: string }).mimeType ?? "unknown"}]`
								: "",
					)
					.filter((x) => x.length > 0)
					.join("\n")
					.trim();
				const mode = !hasText ? "image" : text.length > pin.longMessageChars ? "pointer" : "verbatim";
				carried.push({ id: entry.id, text, images, mode });
			}
			return carried;
		}

		function pinPointer(c: Carried): string {
			if (c.mode === "image" || (c.images.length > 0 && !c.text.replace(/\[image: [^\]]*\]/g, "").trim())) {
				return `[user message ${c.id}: ${c.images.length === 1 ? "an image" : `${c.images.length} images`} (${[...new Set(c.images)].join(", ")}) and no text; ${RECALL_TOOL} reads it]`;
			}
			const first = c.text.split("\n", 1)[0].slice(0, 100);
			return `[user message ${c.id}, ${c.text.length} chars, starts "${first}${first.length < c.text.length ? "…" : ""}"; ${RECALL_TOOL} reads it]`;
		}

		function renderPin(carried: Carried[]): string {
			if (carried.length === 0) return "";
			const lines = [
				"<pinned-user-messages>",
				"The user's earlier messages that left your context, oldest first. Their instructions still apply unless a later message changes them.",
			];
			for (let i = 0; i < carried.length; i++) {
				const c = carried[i];
				if (c.mode === "range") {
					let j = i;
					while (j + 1 < carried.length && carried[j + 1].mode === "range") j++;
					lines.push(
						`[${j - i + 1} user message(s) ${c.id}…${carried[j].id} not shown; ${SEARCH_TOOL} finds them]`,
					);
					i = j;
				} else lines.push(c.mode === "verbatim" ? `--- user message ${c.id} ---\n${c.text}` : pinPointer(c));
			}
			lines.push("</pinned-user-messages>");
			return lines.join("\n");
		}

		function pinCap(): number {
			return opts.pinUserMessages ? Math.floor(opts.pinUserMessages.capFraction * lastWindow) : 0;
		}

		/** Applies the cap passes to `carried` (mutating modes) and returns the rendered block. */
		function capPin(carried: Carried[]): string {
			const pin = opts.pinUserMessages;
			if (!pin || carried.length === 0) return "";
			const cap = pinCap();
			if (cap <= 0) return renderPin(carried);
			const fits = () => textTokens(renderPin(carried)) <= cap;
			const middle = carried.slice(Math.min(pin.protectFirst, carried.length - 1), -1);
			for (const c of middle) {
				if (fits()) break;
				if (c.mode === "verbatim") c.mode = "pointer";
			}
			for (const c of middle) {
				if (fits()) break;
				c.mode = "range";
			}
			// Still over: the protected first messages (newest of them first), then the newest, as pointers.
			const rest = [
				...carried.slice(0, Math.min(pin.protectFirst, carried.length - 1)).reverse(),
				carried[carried.length - 1],
			];
			for (const c of rest) {
				if (fits()) break;
				if (c.mode === "verbatim") c.mode = "pointer";
			}
			return renderPin(carried);
		}

		function pinnedUserBlock(branch: SessionEntry[], firstKeptEntryId: string): string {
			return capPin(pinCarried(branch, firstKeptEntryId));
		}

		/**
		 * P2b: an upper bound on the pinned block for any cut of this branch. The carried messages of a cut are
		 * a prefix P of all user messages U. capPin(P) is at most cap once it fits, otherwise its smallest form
		 * (every message a pointer or image line, the middle one range line), so it is at most
		 * max(cap, smallest form); and it is never more than P rendered as it is, which is at most U rendered as
		 * it is. The smallest form of any prefix is bounded by U's first protectFirst pointer lines, the longest
		 * pointer line of U (the prefix's newest) and a range line counting all of U.
		 */
		function pinUpperTokens(branch: SessionEntry[]): number {
			const pin = opts.pinUserMessages;
			if (!pin) return 0;
			const all = pinCarried(branch, "\u0000none");
			if (all.length === 0) return 0;
			const asIs = textTokens(renderPin(all));
			const lines = all.map((c) => pinPointer(c));
			const longest = lines.reduce((a, b) => (textTokens(b) > textTokens(a) ? b : a), lines[0]);
			const protectedLines = lines.slice(0, Math.min(pin.protectFirst, all.length));
			const range = `[${all.length} user message(s) ${all[0].id}…${all[all.length - 1].id} not shown; ${SEARCH_TOOL} finds them]`;
			const smallest = textTokens(
				[
					"<pinned-user-messages>",
					"The user's earlier messages that left your context, oldest first. Their instructions still apply unless a later message changes them.",
					...protectedLines,
					range,
					longest,
					"</pinned-user-messages>",
				].join("\n"),
			);
			// +8: the block is joined into the header with a newline; the estimate of a concatenation may
			// differ from the sum of its parts by a token or two.
			return Math.min(asIs, Math.max(pinCap(), smallest)) + 8;
		}

		function makeHeader(seq: number, firstKeptEntryId: string, branch: SessionEntry[], withPin = true): string {
			const { task, notes, latest, noteTask } = pinned(branch);
			let omitted = 0;
			for (const entry of branch) {
				if (entry.id === firstKeptEntryId) break;
				if (entry.type === "message" && entry.message.role !== "system") omitted++;
				else if (entry.type === "custom_message") omitted++;
			}
			const lines = [
				`[context window #${seq}] The ${omitted} oldest messages of this session (everything before entry ${firstKeptEntryId}) are no longer in your context, to keep requests within the model's limit.`,
				`Nothing was summarized and nothing was deleted: the complete transcript is kept verbatim.${toolGuide()}`,
			];
			if (opts.pinUserMessages) {
				// P2: the pin replaces the H5 task and latest instruction (both are user messages: carried when
				// they left the window, visible otherwise). A task the model set with context_notes stays pinned.
				if (noteTask) lines.push(`<pinned-task>\n${noteTask}\n</pinned-task>`);
				const block = withPin ? pinnedUserBlock(branch, firstKeptEntryId) : "";
				if (block) lines.push(block);
			} else {
				if (task) lines.push(`<pinned-task>\n${task}\n</pinned-task>`);
				if (latest) lines.push(`<latest-instruction>\n${latest}\n</latest-instruction>`);
			}
			if (notes) lines.push(`<working-notes>\n${notes}\n</working-notes>`);
			return lines.join("\n");
		}

		/**
		 * The header carries the cut's time (never serialized to the provider). Pi's estimateContextTokens
		 * (used by clampMaxTokensToContext for max_tokens) ignores the usage of assistant messages older than
		 * a newer prefix message; with timestamp 0 it trusted the pre-cut usage of the last kept assistant
		 * and squeezed max_tokens on the first request after a cut (3,931 on a 32k/8k model, reserve 6,553).
		 */
		function headerMessage(header: string, at = Date.now() + 1): AgentMessage {
			if (opts.mode === "b-compaction") {
				// Same shape Pi projects for a compaction entry, so materializing the cut later is byte-identical.
				return { role: "compactionSummary", summary: header, tokensBefore: 0, timestamp: at } as AgentMessage;
			}
			return {
				role: "custom",
				customType: HEADER_TYPE,
				content: header,
				display: false,
				timestamp: at,
			} as AgentMessage;
		}

		/**
		 * The header's size before the cut is chosen. Pin off: r5/p1 exactly (a dummy cut; the header does not
		 * depend on the cut beyond its fixed-width numbers). P2b, pin on: the header without the pin plus an
		 * upper bound on the pin for any cut (pinUpperTokens), so it never underestimates; chooseCut then
		 * measures the header at the chosen cut.
		 */
		function headerTokens(branch: SessionEntry[]): number {
			if (!opts.pinUserMessages) return messageTokens(headerMessage(makeHeader(999, "xxxxxxxx", branch)));
			return messageTokens(headerMessage(makeHeader(999, "xxxxxxxx", branch, false))) + pinUpperTokens(branch);
		}

		/**
		 * P2b: choose a cut with the header measured at the cut. Pin off: one choice with headerTokens, as in
		 * r5/p1 (header left to the caller). Pin on, deterministic, at most one extra pass:
		 *   1. choose with the upper bound (base + headerTokens) and render the header at that cut;
		 *   2. if the exact header is smaller, choose once more with it; keep that cut only if its own exact
		 *      header is no larger than the size it was chosen with, else keep the first cut.
		 * The returned fixedAfter is never less than base + the returned header's size, so a request never
		 * exceeds its budget because of the estimate.
		 */
		function chooseCut(
			branch: SessionEntry[],
			seq: number,
			base: number,
			choose: (fixedAfter: number) => number,
			entryAt: (start: number) => string | undefined,
		): { start: number; fixedAfter: number; header?: string } {
			const upper = base + headerTokens(branch);
			const first = choose(upper);
			if (!opts.pinUserMessages) return { start: first, fixedAfter: upper };
			const firstId = entryAt(first);
			if (firstId === undefined) return { start: first, fixedAfter: upper };
			const header1 = makeHeader(seq, firstId, branch);
			const exact1 = base + messageTokens(headerMessage(header1));
			const plan = (start: number, fixedAfter: number, header: string, secondPass: boolean) => {
				stats.headerPlans.push({
					upper: upper - base,
					planned: fixedAfter - base,
					rendered: messageTokens(headerMessage(header)),
					secondPass,
				});
				return { start, fixedAfter, header };
			};
			if (exact1 > upper) {
				// The bound is proven above; this is a guard, not a path: keep the larger number.
				stats.headerBoundMisses++;
				log(`header bound miss: exact ${exact1} > upper ${upper} at cut ${firstId}`);
				return plan(first, exact1, header1, false);
			}
			if (exact1 === upper) return plan(first, exact1, header1, false);
			const second = choose(exact1);
			const secondId = second === first ? undefined : entryAt(second);
			if (secondId === undefined) return plan(first, exact1, header1, false);
			const header2 = makeHeader(seq, secondId, branch);
			const exact2 = base + messageTokens(headerMessage(header2));
			if (exact2 <= exact1) return plan(second, exact2, header2, true);
			return plan(first, exact1, header1, false);
		}

		// ---------------------------------------------------------------- items and caps
		function itemFor(entryId: string, message: AgentMessage, limits: Limits, ratio: number): Item {
			if (message.role === "system")
				return { entryId, message, out: message, tokens: messageTokens(message), startable: false, system: true };
			let decision = decisions.get(entryId);
			if (!decision && cappable(message)) {
				decision = decideCap(message, maxUnitTokens(limits), ratio);
				if (decision) {
					decisions.set(entryId, decision);
					pendingDecisions[entryId] = decision;
					stats.capDecisions++;
				}
			}
			let out: AgentMessage = message;
			if (decision && !decision.materialized) {
				const cached = outCache.get(entryId);
				if (cached && cached.message === message) out = cached.out;
				else {
					out = applyCap(message, entryId, decision);
					outCache.set(entryId, { message, out });
				}
			}
			return { entryId, message, out, tokens: messageTokens(out), startable: isStartable(message), system: false };
		}

		function flushDecisions(): void {
			if (Object.keys(pendingDecisions).length === 0) return;
			pi.appendEntry(STATE_TYPE, { kind: "caps", decisions: pendingDecisions });
			pendingDecisions = {};
		}

		function suffixSums(items: Array<{ tokens: number }>): number[] {
			const sums = new Array<number>(items.length + 1).fill(0);
			for (let i = items.length - 1; i >= 0; i--) sums[i] = sums[i + 1] + items[i].tokens;
			return sums;
		}

		/** Smallest startable index > from (or >= from) whose window fits `target` provider tokens. */
		function chooseStart(
			items: Item[],
			from: number,
			fixedTokens: number,
			target: number,
			ratio: number,
			strictlyAfter = false,
		): number {
			const sums = suffixSums(items);
			let lastStartable = -1;
			for (let s = strictlyAfter ? from + 1 : from; s < items.length; s++) {
				if (!items[s].startable) continue;
				if (s > 0 && items[s - 1].entryId === items[s].entryId) continue;
				lastStartable = s;
				if ((fixedTokens + sums[s]) * ratio <= target) return s;
			}
			return lastStartable >= 0 ? lastStartable : from;
		}

		// ---------------------------------------------------------------- mode a: incremental index (H7)
		function rebuildIndex(ctx: ExtensionContext, limits: Limits, ratio: number): WindowIndex {
			stats.indexRebuilds++;
			const branch = ctx.sessionManager.getBranch();
			const cut = readCut(branch);
			const projection = ctx.sessionManager.buildSessionProjection();
			const all: Item[] = [];
			for (const projected of projection.entries) {
				for (const message of projected.messages)
					all.push(itemFor(projected.sourceEntry.id, message, limits, ratio));
			}
			let start = 0;
			if (cut) {
				start = all.findIndex((item) => item.entryId === cut.firstKeptEntryId);
				if (start < 0) {
					// The cut entry is not projected any more (omitted, or another branch): keep what follows it.
					const order = new Map(branch.map((e, i) => [e.id, i]));
					const at = order.get(cut.firstKeptEntryId);
					start =
						at === undefined
							? 0
							: Math.max(
									0,
									all.findIndex((item) => (order.get(item.entryId) ?? -1) >= at && item.startable),
								);
				}
			}
			const items = all.slice(start);
			const checkpoint =
				start > 0
					? (getCurrentSystemMessage(
							all
								.slice(0, start)
								.filter((i) => i.system)
								.map((i) => i.message) as never,
						) as AgentMessage | undefined)
					: undefined;
			const header = start > 0 && cut ? headerMessage(cut.header, cut.at) : undefined;
			return {
				leafId: ctx.sessionManager.getLeafId(),
				items,
				total: items.reduce((sum, item) => sum + item.tokens, 0),
				cut: start > 0 ? cut : undefined,
				checkpoint,
				checkpointTokens: checkpoint ? messageTokens(checkpoint) : 0,
				header,
				headerTokens: header ? messageTokens(header) : 0,
				recent: [],
			};
		}

		/** Bring the index up to the current leaf by walking only the new entries. */
		function updateIndex(ctx: ExtensionContext, limits: Limits, ratio: number): WindowIndex {
			const rebuild = () => {
				index = rebuildIndex(ctx, limits, ratio);
				return index;
			};
			if (!index) return rebuild();
			const leaf = ctx.sessionManager.getLeafId();
			if (leaf === index.leafId) return index;
			const fresh: SessionEntry[] = [];
			let id: string | null = leaf;
			while (id && id !== index.leafId && fresh.length < 10_000) {
				const entry = ctx.sessionManager.getEntry(id);
				if (!entry) break;
				fresh.push(entry);
				id = entry.parentId;
			}
			if (id !== index.leafId) return rebuild();
			for (const entry of fresh.reverse()) {
				if (entry.type === "compaction") return rebuild();
				if (entry.type === "context_edit") {
					const at = index.items.findIndex((item) => item.entryId === entry.targetId);
					if (at < 0) continue;
					if (entry.replacement !== null) return rebuild();
					index.total -= index.items[at].tokens;
					index.items.splice(at, 1);
					continue;
				}
				for (const message of entryMessages(entry)) {
					const item = itemFor(entry.id, message, limits, ratio);
					index.items.push(item);
					index.total += item.tokens;
				}
			}
			index.leafId = leaf;
			return index;
		}

		function aligned(idx: WindowIndex, messages: AgentMessage[]): boolean {
			const before = messages.length - idx.items.length;
			if (before < 0) return false;
			for (let i = 0; i < idx.items.length; i++)
				if (idx.items[i].message.role !== messages[before + i].role) return false;
			return true;
		}

		/** H6: after a cut, keep the newest images within imageShare of the budget; replace older ones. Frozen. */
		function evictImages(idx: WindowIndex, limits: Limits, ratio: number): void {
			let room = (opts.imageShare * limits.budget) / ratio;
			for (let i = idx.items.length - 1; i >= 0; i--) {
				const item = idx.items[i];
				if (!cappable(item.message)) continue;
				const blocks = contentBlocks(item.message);
				const decision = { ...(decisions.get(item.entryId) ?? {}) };
				const dropped = new Set(decision.dropImages ?? []);
				let changed = false;
				for (let k = blocks.length - 1; k >= 0; k--) {
					const block = blocks[k];
					if (block.type !== "image" || dropped.has(k)) continue;
					const cost = imageTokens(block);
					if (cost <= room) room -= cost;
					else {
						dropped.add(k);
						changed = true;
						stats.imageEvictions++;
					}
				}
				if (!changed) continue;
				decision.dropImages = [...dropped].sort((a, b) => a - b);
				decisions.set(item.entryId, decision);
				pendingDecisions[item.entryId] = decision;
				outCache.delete(item.entryId);
				const replaced = itemFor(item.entryId, item.message, limits, ratio);
				idx.total += replaced.tokens - item.tokens;
				idx.items[i] = replaced;
			}
		}

		/** P4: one line naming what the next cut would remove. */
		function noticeFor(items: Item[], next: number, tokensUntilCut: number): AgentMessage {
			const leaving = items.slice(0, next);
			const tools = new Map<string, number>();
			const files = new Set<string>();
			for (const item of leaving) {
				if (item.message.role !== "assistant") continue;
				for (const block of (item.message as AssistantMessage).content) {
					if (block.type !== "toolCall") continue;
					tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
					const args = (block.arguments ?? {}) as Record<string, unknown>;
					for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
						if (typeof args[key] === "string") files.add(args[key] as string);
					}
				}
			}
			const toolList = [...tools.entries()].map(([name, count]) => `${name}x${count}`).join(", ");
			const fileList = [...files].slice(0, 8).join(", ") + (files.size > 8 ? ` +${files.size - 8} more` : "");
			const text =
				`${NOTICE_MARKER} In about ${Math.max(0, Math.round(tokensUntilCut))} tokens the next cut removes ${leaving.length} messages from your view ` +
				`(entries ${leaving[0]?.entryId}..${leaving.at(-1)?.entryId}${toolList ? `; tools: ${toolList}` : ""}${fileList ? `; files: ${fileList}` : ""}). ` +
				(hasTool(NOTES_TOOL) ? `Save anything you still need to ${NOTES_TOOL} now; the` : "The") +
				` transcript keeps everything${hasTool(SEARCH_TOOL) && hasTool(RECALL_TOOL) ? `, and ${SEARCH_TOOL} and ${RECALL_TOOL} find and read it later` : ""}.`;
			return {
				role: "custom",
				customType: NOTICE_TYPE,
				content: text,
				display: false,
				timestamp: 0,
			} as AgentMessage;
		}

		function requestWindowA(
			messages: AgentMessage[],
			ctx: ExtensionContext,
		): { result?: AgentMessage[]; estimate: number } {
			const limits = resolveLimits(ctx);
			const ratio = ratioFor(limits.key);
			let idx = updateIndex(ctx, limits, ratio);
			if (!aligned(idx, messages)) {
				idx = index = rebuildIndex(ctx, limits, ratio);
				if (!aligned(idx, messages)) {
					stats.alignMismatches++;
					log(`align mismatch window=${idx.items.length} event=${messages.length}`);
					return { estimate: messages.reduce((sum, m) => sum + messageTokens(m), 0) };
				}
			}
			const high = opts.highWater * limits.budget;
			const low = opts.lowWater * limits.budget;
			const fixed = () => (idx.header ? idx.checkpointTokens + idx.headerTokens : 0);
			let projected = (fixed() + idx.total) * ratio;
			let cutNow = false;
			const systemNow = () =>
				getCurrentSystemMessage([
					...(idx.checkpoint ? [idx.checkpoint] : []),
					...idx.items.filter((i) => i.system).map((i) => i.message),
				] as never) as AgentMessage | undefined;
			if (projected > high) {
				const branch = ctx.sessionManager.getBranch();
				const system = systemNow();
				const seq = (idx.cut?.seq ?? 0) + 1;
				const plan = chooseCut(
					branch,
					seq,
					system ? messageTokens(system) : 0,
					(fixedAfter) => chooseStart(idx.items, 0, fixedAfter, low, ratio, true),
					(start) => idx.items[start]?.entryId,
				);
				const fixedAfter = plan.fixedAfter;
				const next = plan.start;
				const sums = suffixSums(idx.items);
				const after = (fixedAfter + sums[next]) * ratio;
				if (next > 0 && after < projected) {
					const firstKeptEntryId = idx.items[next].entryId;
					const header = plan.header ?? makeHeader(seq, firstKeptEntryId, branch);
					pi.appendEntry(STATE_TYPE, { kind: "cut", firstKeptEntryId, seq, header });
					const checkpoint = getCurrentSystemMessage([
						...(idx.checkpoint ? [idx.checkpoint] : []),
						...idx.items
							.slice(0, next)
							.filter((i) => i.system)
							.map((i) => i.message),
					] as never) as AgentMessage | undefined;
					idx.items = idx.items.slice(next);
					idx.total = idx.items.reduce((sum, item) => sum + item.tokens, 0);
					// Strictly after every message that existed at the cut (same-millisecond messages included).
					const at = Date.now() + 1;
					idx.cut = { firstKeptEntryId, seq, header, at };
					idx.checkpoint = checkpoint;
					idx.checkpointTokens = checkpoint ? messageTokens(checkpoint) : 0;
					idx.header = headerMessage(header, at);
					idx.headerTokens = messageTokens(idx.header);
					idx.noticeGiven = false;
					evictImages(idx, limits, ratio);
					const newProjected = (fixed() + idx.total) * ratio;
					stats.cuts.push({
						seq,
						mode: "a",
						where: "request",
						omitted: next,
						before: projected,
						after: newProjected,
					});
					log(
						`cut #${seq} at ${next} entry=${firstKeptEntryId} ${Math.round(projected)} -> ${Math.round(newProjected)} (budget ${limits.budget}, ratio ${ratio.toFixed(3)})`,
					);
					projected = newProjected;
					cutNow = true;
				}
			}
			// P4: request-only notice at the tail when the next request will probably cut.
			let notice: AgentMessage | undefined;
			const growth = Math.max(0, ...idx.recent.slice(1).map((value, i) => value - idx.recent[i]));
			idx.recent = cutNow ? [] : [...idx.recent.slice(-5), projected];
			const threshold = high - Math.max((1 - opts.noticeFraction) * high, 1.5 * growth);
			// G3: once per cut cycle unless repeats are asked for; every cut (and a rebuild) re-arms it.
			if (
				opts.notice &&
				!cutNow &&
				projected > threshold &&
				projected <= high &&
				(opts.noticeRepeats || !idx.noticeGiven)
			) {
				const system = systemNow();
				const fixedAfter = (system ? messageTokens(system) : 0) + Math.max(idx.headerTokens, 300);
				const next = chooseStart(idx.items, 0, fixedAfter, low, ratio, true);
				if (next > 0) {
					notice = noticeFor(idx.items, next, high - projected);
					idx.noticeGiven = true;
					stats.notices++;
				}
			}
			flushDecisions();
			const capped = idx.items.some((item) => item.out !== item.message);
			if (!idx.header && !capped && !notice) return { estimate: idx.total };
			const body = idx.items.map((item) => item.out);
			if (capped) stats.capped++;
			const result = idx.header ? [...(idx.checkpoint ? [idx.checkpoint] : []), idx.header, ...body] : body;
			if (notice) result.push(notice);
			return { result, estimate: fixed() + idx.total + (notice ? messageTokens(notice) : 0) };
		}

		// ---------------------------------------------------------------- other modes (comparison)
		function buildItems(
			entries: ProjectedSessionEntry[],
			limits: Limits,
			ratio: number,
		): { head: Item[]; body: Item[] } {
			const head: Item[] = [];
			const body: Item[] = [];
			for (const projected of entries) {
				const isCompaction = projected.sourceEntry.type === "compaction";
				for (const message of projected.messages) {
					const item = itemFor(projected.sourceEntry.id, message, limits, ratio);
					if (isCompaction && body.length === 0) head.push({ ...item, startable: false });
					else body.push(item);
				}
			}
			return { head, body };
		}

		/** Modes stateless and a-context's guard, and the b-mode guard. Returns undefined to send as is. */
		function requestWindowOther(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] | undefined {
			if (opts.mode === "a-context") return undefined;
			const limits = resolveLimits(ctx);
			const ratio = ratioFor(limits.key);
			const projection = ctx.sessionManager.buildSessionProjection();
			const { head, body } = buildItems(projection.entries, limits, ratio);
			const all = [...head, ...body];
			if (all.length !== messages.length || all.some((item, i) => item.message.role !== messages[i].role)) {
				stats.alignMismatches++;
				log(`align mismatch projected=${all.length} event=${messages.length}`);
				return undefined;
			}
			flushDecisions();
			const branch = ctx.sessionManager.getBranch();
			const anyCapped = body.some((item) => item.out !== item.message);
			const asIs = () => (anyCapped ? all.map((item) => item.out) : undefined);
			const sums = suffixSums(body);
			const fullTokens = all.reduce((sum, item) => sum + item.tokens, 0);
			const checkpoint = (start: number) =>
				getCurrentSystemMessage(
					[...head, ...body.slice(0, start)].filter((i) => i.system).map((i) => i.message) as never,
				) as AgentMessage | undefined;
			const systemNow = getCurrentSystemMessage(all.filter((i) => i.system).map((i) => i.message) as never) as
				| AgentMessage
				| undefined;
			const fixedAfter = (systemNow ? messageTokens(systemNow) : 0) + headerTokens(branch);
			const cost = (start: number) => (start === 0 ? fullTokens : fixedAfter + sums[start]) * ratio;
			const render = (start: number, header: string): AgentMessage[] => {
				const system = checkpoint(start);
				return [...(system ? [system] : []), headerMessage(header), ...body.slice(start).map((item) => item.out)];
			};
			if (opts.mode === "stateless") {
				if (cost(0) <= opts.highWater * limits.budget) return asIs();
				const start = chooseStart(body, 0, fixedAfter, opts.lowWater * limits.budget, ratio);
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
			const projected = cost(0);
			if (projected <= opts.guardFraction * limits.budget) return asIs();
			const plan = chooseCut(
				branch,
				seqCache + 1,
				systemNow ? messageTokens(systemNow) : 0,
				(f) => chooseStart(body, 0, f, opts.lowWater * limits.budget, ratio, true),
				(start) => body[start]?.entryId,
			);
			const start = plan.start;
			const costAt = (start === 0 ? fullTokens : plan.fixedAfter + sums[start]) * ratio;
			if (start <= 0 || costAt >= projected) return asIs();
			stats.guardTrims++;
			log(`guard trim at ${start}/${body.length} projected=${Math.round(projected)}`);
			return render(start, plan.header ?? makeHeader(seqCache + 1, body[start].entryId, branch));
		}

		pi.on("context", async (event, ctx) => {
			if (opts.mode !== "a-context") return undefined;
			try {
				const limits = resolveLimits(ctx);
				const ratio = ratioFor(limits.key);
				const projection = ctx.sessionManager.buildSessionProjection();
				const { body } = buildItems(projection.entries, limits, ratio);
				const slots = body.filter((item) => !item.system);
				if (
					slots.length !== event.messages.length ||
					slots.some((s, i) => s.message.role !== event.messages[i].role)
				) {
					stats.alignMismatches++;
					return undefined;
				}
				flushDecisions();
				const branch = ctx.sessionManager.getBranch();
				const system = getCurrentSystemMessage(projection.messages);
				const systemTokens = system ? messageTokens(system as AgentMessage) : 0;
				const cut = readCut(branch);
				let start = cut
					? Math.max(
							0,
							slots.findIndex((s) => s.entryId === cut.firstKeptEntryId),
						)
					: 0;
				const sums = suffixSums(slots);
				// P2b: with the pin on, the current cut's header is known exactly.
				const currentHeader =
					start > 0
						? opts.pinUserMessages && cut
							? messageTokens(headerMessage(cut.header))
							: headerTokens(branch)
						: 0;
				const projected = (systemTokens + currentHeader + sums[start]) * ratio;
				let header = start > 0 && cut ? cut.header : "";
				if (projected > opts.highWater * limits.budget) {
					const seq = (cut?.seq ?? 0) + 1;
					const from = start;
					const plan = chooseCut(
						branch,
						seq,
						systemTokens,
						(f) => chooseStart(slots, from, f, opts.lowWater * limits.budget, ratio, true),
						(s) => slots[s]?.entryId,
					);
					const fixedAfter = plan.fixedAfter;
					const next = plan.start;
					if (next > start && (fixedAfter + sums[next]) * ratio < projected) {
						header = plan.header ?? makeHeader(seq, slots[next].entryId, branch);
						pi.appendEntry(STATE_TYPE, { kind: "cut", firstKeptEntryId: slots[next].entryId, seq, header });
						stats.cuts.push({
							seq,
							mode: "a-context",
							where: "context",
							omitted: next,
							before: projected,
							after: 0,
						});
						start = next;
					}
				}
				const anyCapped = slots.some((s) => s.out !== s.message);
				if (start === 0 && !anyCapped) return undefined;
				const window = slots.slice(start).map((s) => s.out);
				return {
					messages:
						start > 0
							? [headerMessage(header, cut && header === cut.header ? cut.at : undefined), ...window]
							: window,
				};
			} catch (error) {
				log(`context handler error: ${error instanceof Error ? error.stack : String(error)}`);
				return undefined;
			}
		});

		pi.on("context_with_system", (event, ctx) => {
			if (refused) {
				ctx.abort();
				return undefined;
			}
			let result: AgentMessage[] | undefined;
			let estimate: number | undefined;
			const started = performance.now();
			try {
				if (opts.mode === "a") ({ result, estimate } = requestWindowA(event.messages, ctx));
				else result = requestWindowOther(event.messages, ctx);
			} catch (error) {
				log(`context_with_system error: ${error instanceof Error ? error.stack : String(error)}`);
			}
			// E3: remember the estimate of exactly what is sent; message_end pairs it with provider usage.
			const sentMessages = result ?? event.messages;
			estimate ??= sentMessages.reduce((sum, m) => sum + messageTokens(m), 0);
			const limits = resolveLimits(ctx);
			// R5: what this request appended to the previous one (the silent-truncation evidence).
			const shape = requestShape(sentMessages);
			const appendOnly =
				sentShape !== undefined &&
				shape.keys.length >= sentShape.keys.length &&
				sentShape.keys.every((k, i) => shape.keys[i] === k);
			let appendedText = 0;
			let afterLengthStop = false;
			if (appendOnly) {
				for (const m of sentMessages.slice(sentShape!.keys.length, shape.keys.length)) {
					appendedText += replayedTokens(m) - messageImageTokens(m);
					if (m.role === "assistant" && (m as AssistantMessage).stopReason === "length") afterLengthStop = true;
				}
			}
			lastSent = {
				estimate,
				key: limits.key,
				seq: ++sendSeq,
				appendOnly,
				appendedText,
				noticeDrop: sentShape?.noticeTokens ?? 0,
				afterLengthStop,
			};
			sentShape = shape;
			stats.sent.push({ estimate, ratio: ratioFor(limits.key), budget: limits.budget });
			stats.handlerMs.push(performance.now() - started);
			lastRequestTokens = estimate * ratioFor(limits.key);
			updateStatus(ctx, limits);
			return result ? { messages: result } : undefined;
		});

		// ---------------------------------------------------------------- status line and doctor (H8)
		function currentSeq(): number {
			return opts.mode === "a" ? (index?.cut?.seq ?? 0) : seqCache;
		}

		function updateStatus(ctx: ExtensionContext, limits: Limits): void {
			stats.lastLimits = {
				key: limits.key,
				window: limits.window,
				reason: limits.reason,
				declaredWindow: limits.declaredWindow,
				budget: limits.budget,
				high: limits.high,
				low: limits.low,
				reserve: limits.reserve,
				maxOutput: limits.maxOutput,
			};
			const differs = limits.declaredWindow !== limits.window;
			const model = differs
				? ` (model ${limits.declaredWindow ? kTokens(limits.declaredWindow) : "?"}, ${limits.reason})`
				: "";
			const request =
				lastRequestTokens === undefined ? "" : ` · req ${kTokens(lastRequestTokens)}/${kTokens(limits.high)}`;
			const faultFlag = faults ? "FAULTS ON · " : "";
			const text = `${faultFlag}ctx ${kTokens(limits.window)}${model}${request} · ${currentSeq()} cuts · ratio ${ratioFor(limits.key).toFixed(2)}`;
			stats.statusTexts.push(text);
			ctx.ui.setStatus(STATE_TYPE, text);
		}

		function doctorReport(ctx: ExtensionContext): string {
			const limits = resolveLimits(ctx);
			const n = (value: number) => Math.round(value).toLocaleString("en-US");
			const model = ctx.model;
			const registered = model ? !!ctx.modelRegistry.find(model.provider, model.id) : false;
			const state = limits.state;
			const learned = [...models.entries()].flatMap(([key, m]) => {
				const l = m.learned;
				if (!l) return [];
				const truncated = l.truncatedTurns?.length
					? `; answers from truncated input: ${l.truncatedTurns.map((t) => `turn ${t.turn ?? "?"} (entry ${t.entryId ?? "?"})`).join(", ")}`
					: "";
				const expiry =
					l.source === "plateau"
						? `this session only, never re-probed (probing would truncate silently)${truncated}; clear with /${opts.commandName} reset-limits`
						: l.confirmations >= opts.probeConfirmations
							? `permanent after ${l.confirmations} failed re-probes`
							: l.window > l.base
								? `probing at ${n(l.window)}: retired when a request above ${n(l.evidenceAbove ?? l.base)} succeeds, confirmed by a rejection near ${n(l.base)} (${l.confirmations}/${opts.probeConfirmations} confirmations)`
								: `re-probe toward ${n(l.declared)} after ${Math.max(0, l.probeAfter - l.cleanNear)} more clean requests near the limit (${l.cleanNear}/${l.probeAfter}; ${l.confirmations}/${opts.probeConfirmations} confirmations)`;
				return [`  ${key}: ${n(l.window)} (${l.source}; evidence base ${n(l.base)}; ${expiry})`];
			});
			let decisionsText = 0;
			let decisionsImages = 0;
			for (const decision of decisions.values()) {
				if (decision.chars !== undefined) decisionsText++;
				if (decision.dropImages?.length) decisionsImages++;
			}
			const compactionOff = pi.getSettings().compaction?.enabled === false;
			const lines = [
				"context-engine doctor",
				`model: ${limits.key}${registered ? "" : " (not in the model registry)"}`,
				`declared: window ${limits.declaredWindow ? n(limits.declaredWindow) : "none"}, max output ${limits.declaredMax ? n(limits.declaredMax) : "none"}${limits.plausibleMax || !limits.declaredMax ? "" : ` (implausible: above ${Math.round(opts.implausibleOutputFraction * 100)}% of the window)`}`,
				`effective window: ${n(limits.window)} (reason: ${limits.reason}; ceiling ${ceiling ? n(ceiling) : "off"}${perModel[limits.key]?.contextWindow ? `; override ${n(perModel[limits.key].contextWindow!)}` : ""})`,
				`max output: ${n(limits.maxOutput)} (${limits.maxOutputReason}); a request may ask up to min(max output, ${n(limits.hardWindow)} - input)`,
				`output reserve: ${n(limits.reserve)} = min(max output, ${Math.round(opts.outputReserveFraction * 100)}% of the window)`,
				`input budget: ${n(limits.budget)} = window - output reserve`,
				`band: cut above ${n(limits.high)}, cut down to ${n(limits.low)} (${Math.round(opts.highWater * 100)}% / ${Math.round(opts.lowWater * 100)}% of the budget)`,
				`calibration: ratio ${ratioFor(limits.key).toFixed(3)} over ${state.samples} samples for ${limits.key} (floor ${opts.ratioFloor}, ceiling ${opts.ratioCeiling})`,
				`learned windows:${learned.length ? `\n${learned.join("\n")}` : " none"}`,
				`learned output: ${state.output.ceiling ? `provider ceiling ${n(state.output.ceiling)} (from ${state.output.ceilingSource === "error" ? "an output-limit error" : "length stops"})` : "no provider ceiling"}, ${state.output.raised ? `raised to ${n(state.output.raised)}` : "not raised"}${state.output.contextLimit ? `, output room bounded by a stated context of ${n(state.output.contextLimit)}` : ""}`,
				`unit caps: one unit at most ${n(limits.maxUnit)} tokens (${Math.round(opts.maxUnitFraction * 100)}% of the budget); ${decisions.size} frozen decisions (${decisionsText} text, ${decisionsImages} with images replaced)`,
				`window: #${currentSeq()}${lastRequestTokens === undefined ? "" : `, last request ${n(lastRequestTokens)} tokens (${Math.round((100 * lastRequestTokens) / limits.high)}% of the cut threshold)`}`,
				`compaction.enabled is false: ${compactionOff ? "yes" : "NO (the engine refuses to run)"}`,
				`fault injection: ${faults ? `ON (${describeFaults(faults)}); ${stats.faults.length} injected so far` : faultsRefused ? `REFUSED (${faultsRefused} marks production)` : "off"}`,
			];
			return lines.join("\n");
		}

		/** G2: forget every learned window and output limit of this session (plateau ones included). */
		function resetLimits(ctx: ExtensionContext): string {
			const cleared: string[] = [];
			for (const [key, state] of models) {
				const parts = [
					state.learned ? `window ${state.learned.window} (${state.learned.source})` : "",
					state.output.ceiling ? `output ceiling ${state.output.ceiling}` : "",
					state.output.raised ? `raised output ${state.output.raised}` : "",
					state.output.contextLimit ? `output room ${state.output.contextLimit}` : "",
				].filter(Boolean);
				state.learned = undefined;
				state.output = { stops: [] };
				state.warnedPlateau = false;
				state.history = [];
				state.recent = [];
				state.suspects = [];
				if (parts.length > 0) {
					cleared.push(`${key}: ${parts.join(", ")}`);
					persistModel(key);
				}
			}
			stats.limitResets++;
			const text = cleared.length
				? `context-engine: learned limits cleared for this session: ${cleared.join("; ")}.`
				: "context-engine: no learned limits to clear.";
			log(`reset-limits: ${cleared.join("; ") || "nothing"}`);
			updateStatus(ctx, resolveLimits(ctx));
			return text;
		}

		pi.registerCommand(opts.commandName, {
			description:
				"context-engine: `doctor` prints the window, band, calibration and learned limits; `reset-limits` forgets learned limits",
			handler: async (args, ctx) => {
				const sub = args.trim();
				if (sub === "doctor" || sub === "") ctx.ui.notify(doctorReport(ctx), "info");
				else if (sub === "reset-limits") ctx.ui.notify(resetLimits(ctx), "info");
				else ctx.ui.notify(`usage: /${opts.commandName} doctor | reset-limits`, "warning");
			},
		});

		// ---------------------------------------------------------------- fault injection (D1)
		function faultFor(response: number): "overflow" | "output-limit" | "length" | undefined {
			if (!faults) return undefined;
			const fires = (rule: FaultRule | undefined) => {
				if (!rule) return false;
				if (rule.at?.includes(response)) return true;
				if (rule.every && rule.every > 0 && response % rule.every === 0) return true;
				return rule.probability !== undefined && rule.probability > 0 && faultRandom() < rule.probability;
			};
			if (fires(faults.overflow)) return "overflow";
			if (fires(faults.outputLimit)) return "output-limit";
			if (fires(faults.length)) return "length";
			return undefined;
		}

		/** D1: turn a successful response into an injected fault, loudly. Returns the replacement. */
		function injectFault(message: AssistantMessage, ctx: ExtensionContext): AssistantMessage | undefined {
			if (!faults) return undefined;
			responseCount++;
			const kind = faultFor(responseCount);
			if (!kind) return undefined;
			const limits = resolveLimits(ctx);
			const usage = message.usage;
			const input =
				usage.input + usage.cacheRead + usage.cacheWrite ||
				Math.round((lastSent?.estimate ?? 0) * ratioFor(limits.key));
			const tag = "[context-engine injected fault]";
			const noUsage = { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
			let replacement: AssistantMessage;
			if (kind === "overflow") {
				const limit = Math.max(1_000, Math.floor(input * 0.9));
				replacement = {
					...message,
					content: [],
					stopReason: "error",
					errorMessage: `${tag} prompt is too long: ${input} tokens > ${limit} maximum`,
					usage: noUsage,
				};
			} else if (kind === "output-limit") {
				const sent = lastOutputLimit?.sent ?? limits.maxOutput;
				const ceiling = Math.max(opts.minOutputLimit, Math.floor(sent / 2));
				replacement = {
					...message,
					content: [],
					stopReason: "error",
					errorMessage: `${tag} max_tokens: ${sent} > ${ceiling}, which is the maximum allowed number of output tokens for ${message.model}`,
					usage: noUsage,
				};
			} else {
				// A length stop: the text is cut in half; Pi fails any tool call of a length-stopped message.
				const content = message.content.map((block) =>
					block.type === "text"
						? { ...block, text: block.text.slice(0, Math.ceil(block.text.length / 2)) }
						: block,
				);
				replacement = { ...message, content, stopReason: "length" };
			}
			stats.faults.push({ response: responseCount, kind });
			const line = `FAULT INJECTED #${stats.faults.length} (${kind}) on response ${responseCount}: ${replacement.errorMessage ?? "stopReason length, text halved"}`;
			log(line);
			ctx.ui.notify(`context-engine: ${line}`, "warning");
			return replacement;
		}

		// ---------------------------------------------------------------- provider errors (G1)
		/** G1: learn the output ceiling: the stated number, else half of what was asked (bounded below). */
		function learnOutputCeiling(limits: Limits, info: ProviderErrorInfo): string {
			const state = limits.state;
			const sent = lastOutputLimit?.sent ?? info.requestedOutput ?? limits.maxOutput;
			let ceiling = info.outputLimit;
			let how = "stated";
			if (!ceiling || ceiling >= sent) {
				ceiling = Math.max(opts.minOutputLimit, Math.floor(sent / 2));
				how = "stepped down";
			}
			lastOutputProgress = ceiling < sent;
			if (!lastOutputProgress) return `no lower output to try (asked ${sent}, floor ${opts.minOutputLimit})`;
			state.output.ceiling = Math.min(state.output.ceiling ?? Number.POSITIVE_INFINITY, ceiling);
			state.output.ceilingSource = "error";
			if (state.output.raised && state.output.raised > state.output.ceiling) state.output.raised = undefined;
			stats.outputCeilings.push({ key: limits.key, ceiling: state.output.ceiling });
			persistModel(limits.key);
			return `output ceiling ${state.output.ceiling} (${how}; asked ${sent}); window unchanged at ${limits.window}`;
		}

		/** G1: input + output > context with the input fitting: bound the output room, recalibrate, keep the window. */
		function learnOutputRoom(limits: Limits, info: ProviderErrorInfo): string {
			const state = limits.state;
			const input = info.input ?? 0;
			const contextLimit = info.contextLimit ?? limits.hardWindow;
			if (
				opts.calibrate &&
				input > 0 &&
				lastSent &&
				lastSent.estimate > 0 &&
				input / lastSent.estimate > state.ratio
			) {
				state.ratio = clampRatio(input / lastSent.estimate);
			}
			if (contextLimit < (state.output.contextLimit ?? Number.POSITIVE_INFINITY))
				state.output.contextLimit = contextLimit;
			const room = contextLimit - input - 256;
			const sent = lastOutputLimit?.sent ?? info.requestedOutput ?? limits.maxOutput;
			lastOutputProgress = room >= 256 && room < sent;
			outputCapOnce = Math.max(256, room);
			persistModel(limits.key);
			return `context ${contextLimit} bounds output room; the retry asks at most ${outputCapOnce} (input ${input}); window unchanged at ${limits.window}`;
		}

		function onProviderError(message: AssistantMessage, ctx: ExtensionContext): ProviderErrorInfo {
			const info = classifyProviderError(message.errorMessage, message.provider);
			const limits = resolveLimits(ctx);
			let learned: string | undefined;
			if (info.class === "output-limit") learned = learnOutputCeiling(limits, info);
			else if (info.class === "combined-output-caused") learned = learnOutputRoom(limits, info);
			stats.providerErrors.push({ key: limits.key, class: info.class, rule: info.rule, learned });
			log(
				`provider error (${info.class}; ${info.rule}): "${message.errorMessage}"${learned ? ` -> ${learned}` : ""}`,
			);
			return info;
		}

		// ---------------------------------------------------------------- calibration (E3, H1, H2, H3)
		pi.on("message_end", (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant") return undefined;
			let assistant = message as AssistantMessage;
			let replacement: AssistantMessage | undefined;
			if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
				replacement = injectFault(assistant, ctx);
				if (replacement) assistant = replacement;
			}
			if (assistant.stopReason === "error") onProviderError(assistant, ctx);
			else if (assistant.stopReason !== "aborted") calibrate(assistant, ctx);
			return replacement ? { message: replacement } : undefined;
		});

		function calibrate(assistant: AssistantMessage, ctx: ExtensionContext): void {
			overflowRetries = 0;
			outputRetries = 0;
			lastOutputProgress = true;
			const usage = assistant.usage;
			const reported = usage.input + usage.cacheRead + usage.cacheWrite;
			const sent = lastSent;
			lastSent = undefined;
			if (!sent || sent.estimate <= 0 || reported <= 0) return;
			const key = sent.key;
			const state = modelState(key);
			const sample = reported / sent.estimate;
			stats.calibrationSamples.push(sample);
			// R5 silent truncation. A provider that drops part of an oversized request reports less than it
			// was sent. Between two consecutive requests whose message list only grew, reported usage must
			// grow by about what was appended (text only: image costs differ too much between providers).
			// A sample that does not is quarantined: it is evidence, and it never moves the ratio or the
			// running maximum. A sample reporting exactly the running maximum again while it was expected
			// above it is evidence too (servers that fill their context report exactly the limit).
			const ratioBefore = clampRatio(state.ratio);
			const expected = sent.estimate * ratioBefore;
			const prev = state.lastSample;
			let suspect: string | undefined;
			let strong = false;
			const max = state.maxReported;
			// The exact-repeat rule below compares with the largest usage ever reported: only with settled
			// calibration (not during warm-up or after a model switch) and only for a different request than
			// the one that set it (identical windows report identical counts).
			const levelRepeat =
				max > 0 &&
				state.samples >= opts.silentSettledSamples &&
				Math.abs(expected - (state.maxExpected ?? 0)) >= 0.005 * expected;
			// A sample whose growth falls short but not far enough to be evidence never clears evidence.
			let marginal = false;
			// A request right after an answer cut at the output limit is never evidence on its own: what the
			// provider counts of a cut answer is provider-specific. It cannot clear evidence either.
			if (sent.afterLengthStop) {
				marginal = true;
				log("length stop: the next usage sample is not judged for truncation");
			} else if (prev && prev.seq === sent.seq - 1 && sent.appendOnly) {
				const grow = (sent.appendedText - sent.noticeDrop) * ratioBefore;
				const delta = reported - prev.reported;
				const shown = `${Math.round(grow)} tokens appended, reported usage ${delta >= 0 ? "+" : ""}${delta}`;
				// An honest provider cannot report the same or less after text was appended, however little.
				if (delta <= 0 && grow >= opts.silentZeroGrowthFloor) {
					suspect = shown;
					strong = true;
				}
				// Otherwise an absolute floor: an honest provider counts the appended part exactly; only its
				// estimate varies, so small appends say little.
				else if (grow >= opts.silentMinGrowth) {
					if (delta < opts.silentShortfall * grow && expected >= 0.8 * max) {
						suspect = shown;
						// Most of a large append unaccounted for: no tokenizer overcounts text by that much
						// (the estimator's classes stay within 0.85-1.12 of o200k and GLM; a chars/4 count
						// within 3x).
						strong = grow >= opts.silentStrongGrowth && delta < opts.silentStrongShortfall * grow;
					} else if (delta < opts.silentMarginal * grow) marginal = true;
				}
			}
			if (
				!suspect &&
				!sent.afterLengthStop &&
				levelRepeat &&
				reported === max &&
				expected > reported &&
				expected <= 1.6 * reported
			) {
				suspect = `reported exactly the previous maximum ${reported} again, expected about ${Math.round(expected)}`;
			}
			state.lastSample = { seq: sent.seq, reported };
			state.recent = [
				...state.recent.slice(-15),
				{ at: assistant.timestamp, expected, reported, ratio: state.ratio, suspect },
			];
			if (suspect) {
				state.suspects = [
					...state.suspects.filter((e) => state.samples - e.sample < opts.silentEvidenceSpan),
					{ reported, at: assistant.timestamp, sample: state.samples, why: suspect },
				];
				log(
					`silent truncation evidence ${state.suspects.length}/${opts.silentSuspects}${strong ? " (strong)" : ""}: ${suspect}; sample quarantined`,
				);
				if (strong || state.suspects.length >= opts.silentSuspects) detectSilentTruncation(key, state, ctx);
				return;
			}
			// A clean sample above everything reported so far clears the evidence (the provider processed more
			// than the suspected limit). A truncated request may report only what the server kept, so a value
			// above that remainder proves nothing.
			if (
				state.suspects.length > 0 &&
				!marginal &&
				reported >
					Math.max(state.maxReported, ...state.suspects.map((e) => e.reported)) * (1 + opts.plateauFlatness)
			) {
				log(`silent truncation evidence cleared: ${reported} reported`);
				state.suspects = [];
			}
			if (reported > state.maxReported) {
				state.maxReported = reported;
				state.maxExpected = expected;
			}
			const alpha = state.samples < 3 ? 0.5 : 0.2;
			const previous = state.ratio;
			state.ratio = clampRatio(state.samples === 0 ? sample : state.ratio * (1 - alpha) + sample * alpha);
			state.samples++;
			let dirty = Math.abs(state.ratio - previous) / previous > 0.03 || state.samples % 50 === 0;
			// H3: count clean requests near a learned limit, then re-probe toward the declared window.
			// H8: only evidence retires a learned limit: a successful request above it. Stepping up to the
			// declared window does not, so a re-probe that fails near the old limit still counts as a
			// confirmation (with the 200k ceiling a 100k limit re-probes at 150k, whose band barely passes 100k).
			const learned = state.learned;
			if (learned && learned.source !== "plateau" && learned.confirmations < opts.probeConfirmations) {
				const evidence = learned.evidenceAbove ?? learned.base;
				if (learned.window > learned.base && reported > evidence) {
					state.learned = undefined;
					stats.probes.push({ key, from: learned.window, to: learned.declared });
					log(`probe: ${reported} > ${evidence} succeeded at ${learned.window} (learned window retired)`);
					dirty = true;
				} else if (learned.window < learned.declared) {
					if (reported >= 0.5 * learned.window) learned.cleanNear++;
					if (learned.cleanNear >= learned.probeAfter) {
						const from = learned.window;
						const next = from + Math.max(0.5 * (learned.declared - from), 0.25 * from);
						learned.window = next >= 0.9 * learned.declared ? learned.declared : Math.floor(next);
						learned.cleanNear = 0;
						stats.probes.push({ key, from, to: learned.window });
						log(`probe: ${from} -> ${learned.window}`);
						dirty = true;
					}
				}
			}
			if (dirty) persistModel(key);
		}

		/**
		 * R5: silent truncation found. The largest usage the provider ever reported is the window it
		 * really processes: learn it for this session (never re-probed: probing would truncate again),
		 * restore the ratio from before the affected samples, and name them (G2).
		 */
		function detectSilentTruncation(key: string, state: ModelState, ctx: ExtensionContext): void {
			const limits = resolveLimits(ctx);
			const max = Math.max(state.maxReported, ...state.suspects.map((e) => e.reported));
			const window = Math.min(limits.window, Math.floor(max));
			// Affected: the quarantined samples; samples that reported exactly what a quarantined one did (a
			// server that fills its context reports the limit every time); and samples at the maximum that
			// fell clearly short of their expectation.
			const suspectCounts = new Set(state.suspects.map((e) => e.reported));
			const affected = state.recent.filter(
				(s) =>
					s.suspect !== undefined ||
					suspectCounts.has(s.reported) ||
					(s.reported >= max * (1 - opts.plateauFlatness) && s.expected > s.reported * (1 + opts.plateauFlatness)),
			);
			if (affected.length > 0) state.ratio = affected[0].ratio;
			state.learned = {
				window,
				base: window,
				declared: limits.metadataWindow,
				source: "plateau",
				confirmations: opts.probeConfirmations,
				cleanNear: 0,
				probeAfter: Number.POSITIVE_INFINITY,
				scope: "session",
			};
			stats.plateaus.push({ key, window });
			stats.learnedWindows.push({ key, window, source: "plateau", confirmations: 0 });
			persistModel(key);
			log(
				`silent truncation: ${state.suspects.map((e) => e.why).join("; ")}; largest usage ever reported ${max}; window -> ${window} (this session only)`,
			);
			pendingPlateau = { key, window, max, samples: affected };
			state.recent = [];
			state.suspects = [];
			state.history = [];
		}

		/** G2: name the answers produced from truncated input, in the log, a warning and a session entry. */
		function reportPlateau(ctx: ExtensionContext, drafts: SessionBoundaryDraft[]): void {
			const pending = pendingPlateau;
			pendingPlateau = undefined;
			if (!pending) return;
			const assistants = ctx.sessionManager
				.getBranch()
				.filter((e) => e.type === "message" && e.message.role === "assistant");
			const turns: TruncatedTurn[] = pending.samples.map((s) => {
				const index = assistants.findIndex(
					(e) => e.type === "message" && (e.message as AssistantMessage).timestamp === s.at,
				);
				return {
					entryId: index >= 0 ? assistants[index].id : undefined,
					turn: index >= 0 ? index + 1 : undefined,
					at: new Date(s.at).toISOString(),
					expected: Math.round(s.expected),
					reported: s.reported,
				};
			});
			const state = modelState(pending.key);
			if (state.learned?.source === "plateau") state.learned.truncatedTurns = turns;
			stats.plateauReports.push({ key: pending.key, window: pending.window, turns });
			for (const t of turns) {
				log(
					`plateau: truncated answer entry=${t.entryId ?? "?"} turn=${t.turn ?? "?"} at=${t.at} expected~${t.expected} processed=${t.reported}`,
				);
			}
			drafts.push({
				type: "custom",
				customType: STATE_TYPE,
				data: { kind: "plateau", key: pending.key, window: pending.window, turns },
			});
			drafts.push({ type: "custom", customType: STATE_TYPE, data: snapshot(pending.key) });
			state.warnedPlateau = true;
			const named = turns.map((t) => `turn ${t.turn ?? "?"} (entry ${t.entryId ?? "?"}, ${t.at})`).join("; ");
			ctx.ui.notify(
				`context-engine: ${pending.key} silently truncated its input at about ${Math.floor(pending.max)} tokens (reported usage fell short of what the requests carried). ` +
					`${turns.length} answers were produced without part of their input (the provider may have dropped the start of the request: system prompt, window header, pinned task) and may be unreliable: ${named}. ` +
					`The window is now ${pending.window} tokens for this session only; /${opts.commandName} reset-limits clears it.`,
				"warning",
			);
		}

		// ---------------------------------------------------------- boundaries (E2 b, E5, E6, H4)
		function buildSlots(
			entries: ProjectedSessionEntry[],
			limits: Limits,
			ratio: number,
		): { slots: Item[]; overhead: AgentMessage[] } {
			const slots: Item[] = [];
			const overhead: AgentMessage[] = [];
			for (const projected of entries) {
				const isCompaction = projected.sourceEntry.type === "compaction";
				for (const message of projected.messages) {
					if (message.role === "system" || isCompaction) {
						overhead.push(message);
						continue;
					}
					slots.push(itemFor(projected.sourceEntry.id, message, limits, ratio));
				}
			}
			return { slots, overhead };
		}

		function planBoundary(
			entries: ProjectedSessionEntry[],
			ctx: ExtensionContext,
			limits: Limits,
			reserveTokens: number,
			force: boolean,
		): SessionBoundaryDraft[] {
			const ratio = ratioFor(limits.key);
			const branch = ctx.sessionManager.getBranch();
			const { slots, overhead } = buildSlots(entries, limits, ratio);
			flushDecisions();
			const overheadTokens = overhead.reduce((a, m) => a + messageTokens(m), 0);
			const sums = suffixSums(slots);
			const projected = (overheadTokens + sums[0] + reserveTokens) * ratio;
			if (!force && projected <= opts.highWater * limits.budget) return [];
			const system = getCurrentSystemMessage(entries.flatMap((e) => e.messages) as never) as
				| AgentMessage
				| undefined;
			const target = force
				? Math.min(opts.lowWater * limits.budget, projected * 0.5)
				: opts.lowWater * limits.budget;
			const plan = chooseCut(
				branch,
				seqCache + 1,
				(system ? messageTokens(system) : 0) + reserveTokens,
				(f) => chooseStart(slots, 0, f, target, ratio, true),
				(s) => slots[s]?.entryId,
			);
			const fixedAfter = plan.fixedAfter;
			const start = plan.start;
			if (start <= 0) return [];
			const after = (fixedAfter + sums[start]) * ratio;
			if (after >= projected) return [];
			const seq = seqCache + 1;
			seqCache = seq;
			const firstKeptEntryId = slots[start].entryId;
			const header = plan.header ?? makeHeader(seq, firstKeptEntryId, branch);
			stats.cuts.push({ seq, mode: opts.mode, where: "boundary", omitted: start, before: projected, after });
			log(
				`boundary cut #${seq} at slot ${start}/${slots.length} entry=${firstKeptEntryId} ${Math.round(projected)} -> ${Math.round(after)}`,
			);
			if (opts.mode === "b-compaction") {
				return [{ type: "compaction", summary: header, firstKeptEntryId, details: { engine: STATE_TYPE, seq } }];
			}
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

		/** b modes: caps for new tool results become persisted context_edit replacements. */
		function capDrafts(entryIds: string[], ctx: ExtensionContext, limits: Limits): SessionBoundaryDraft[] {
			const drafts: SessionBoundaryDraft[] = [];
			const ratio = ratioFor(limits.key);
			for (const id of entryIds) {
				const entry = ctx.sessionManager.getEntry(id);
				if (!entry || entry.type !== "message") continue;
				const message = entry.message as AgentMessage;
				const decision = decideCap(message, maxUnitTokens(limits), ratio);
				if (!decision) continue;
				stats.capDecisions++;
				decisions.set(id, { ...decision, materialized: true });
				pendingDecisions[id] = { ...decision, materialized: true };
				const capped = applyCap(message, id, decision);
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
			reportPlateau(ctx, drafts);
			const message = event.message as AssistantMessage;
			if (message.role === "assistant" && message.stopReason === "length") {
				const hasToolCalls = message.content.some((block) => block.type === "toolCall");
				const limits = resolveLimits(ctx);
				const state = limits.state;
				const output = message.usage.output;
				const sent = lastOutputLimit?.sent;
				// H4: the stop hit the limit we asked for. If the engine lowered it, raise it for the retry.
				if (sent && output >= sent * 0.98 && lastOutputLimit?.lowered) {
					const raised = Math.min(
						Math.max(sent * 2, limits.maxOutput),
						Math.floor(limits.hardWindow / 2),
						state.output.ceiling ?? Number.POSITIVE_INFINITY,
					);
					if (raised > (state.output.raised ?? 0) && raised > sent) {
						state.output.raised = raised;
						stats.outputRaised.push({ key: limits.key, to: raised });
						drafts.push({ type: "custom", customType: STATE_TYPE, data: snapshot(limits.key) });
						log(`output: length stop at the engine's clamp ${sent}; raised to ${raised}`);
					}
				} else if (sent && output < sent * 0.98) {
					// The provider stopped below what we asked: a real output ceiling once it repeats.
					state.output.stops = [...state.output.stops.slice(-3), output];
					const same = state.output.stops.filter((x) => Math.abs(x - output) <= 0.02 * output);
					if (same.length >= 2 && state.output.ceiling !== Math.max(...same)) {
						state.output.ceiling = Math.max(...same);
						state.output.ceilingSource = "length";
						stats.outputCeilings.push({ key: limits.key, ceiling: state.output.ceiling });
						drafts.push({ type: "custom", customType: STATE_TYPE, data: snapshot(limits.key) });
						log(`output: provider ceiling learned at ${state.output.ceiling}`);
					}
				}
				if (hasToolCalls && state.output.ceiling && output >= state.output.ceiling * 0.98 && !hintedThisRun) {
					hintedThisRun = true;
					drafts.push({
						type: "custom_message",
						customType: CONTINUE_TYPE,
						content: `Your tool call was cut off at the provider's output limit (about ${state.output.ceiling} tokens per response) and was not executed. Retrying the same call will fail the same way: split the content into several smaller tool calls (for example, write the file in parts).`,
						display: false,
					});
				}
				// E6: length continuation for text answers, bounded.
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
				drafts.push(...planBoundary(event.context.contextEntries, ctx, limits, 0, false));
			}
			if (drafts.length === event.entries.length && shouldContinue === event.continue) return undefined;
			return { entries: drafts, continue: shouldContinue };
		});

		/** E5 + H3: learn from an overflow. Returns the new believed window. */
		function learnFromOverflow(
			limits: Limits,
			errorMessage: string | undefined,
			drafts: SessionBoundaryDraft[],
			info: ProviderErrorInfo = classifyProviderError(errorMessage),
		): number {
			const state = limits.state;
			// G1: a combined error that the input alone does not fit states the input part separately.
			const parsed = parseOverflow(errorMessage);
			const limit = info.contextLimit ?? parsed.limit;
			const requested = info.input ?? parsed.requested;
			if (opts.calibrate && requested && lastSent && requested / lastSent.estimate > state.ratio) {
				state.ratio = clampRatio(requested / lastSent.estimate);
			}
			const sent = requested ?? (lastSent ? lastSent.estimate * ratioFor(limits.key) : limits.window);
			let shrunk = limits.window;
			if (limit && limit < limits.window) shrunk = limit;
			else if (limit && !(opts.calibrate && requested)) {
				// The limit is not below our window, so our units are off and cannot be recalibrated: go below what we sent.
				shrunk = Math.min(limits.window, Math.floor((lastSent?.estimate ?? sent) * ratioFor(limits.key) * 0.85));
			} else if (!limit && (sent >= 0.5 * limits.window || overflowRetries > 1)) {
				shrunk = Math.min(limits.window, Math.floor(sent * 0.85));
			}
			const learned = state.learned;
			if (shrunk < limits.window || (learned && learned.window > learned.base)) {
				const source: LearnedWindow["source"] = limit ? "parsed" : "unparsed";
				if (learned && Math.abs(Math.min(shrunk, limits.window) - learned.base) <= 0.05 * learned.base) {
					// A re-probe failed at the limit we already knew: one more confirmation, longer wait.
					learned.confirmations++;
					learned.probeAfter *= 2;
					learned.window = learned.base;
					learned.cleanNear = 0;
				} else {
					state.learned = {
						window: shrunk,
						base: shrunk,
						declared: limits.metadataWindow,
						source,
						confirmations: 0,
						cleanNear: 0,
						probeAfter: source === "parsed" ? opts.probeAfterParsed : opts.probeAfterUnparsed,
						evidenceAbove: limit && limit < limits.window ? limit : Math.round(sent),
					};
				}
				const now = state.learned!;
				stats.learnedWindows.push({
					key: limits.key,
					window: now.window,
					source: now.source,
					confirmations: now.confirmations,
				});
			}
			drafts.push({ type: "custom", customType: STATE_TYPE, data: snapshot(limits.key) });
			log(
				`overflow: "${errorMessage}" limit=${limit} requested=${requested} sent=${Math.round(sent)} window ${limits.window} -> ${state.learned?.window ?? limits.window} (confirmations ${state.learned?.confirmations ?? 0})`,
			);
			return state.learned?.window ?? limits.window;
		}

		pi.on("agent_before_settle", (event, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const projection = event.context.contextEntries;
			// E5: the final attempt overflowed. Find it in the projection (Pi may already have omitted it).
			const lastAssistant = [...branch]
				.reverse()
				.find((e) => e.type === "message" && e.message.role === "assistant");
			const lastMessage =
				lastAssistant?.type === "message" ? (lastAssistant.message as AssistantMessage) : undefined;
			// G1: classify before relying on Pi's isContextOverflow (it reads some combined errors as overflow).
			const info =
				lastMessage?.stopReason === "error"
					? classifyProviderError(lastMessage.errorMessage, lastMessage.provider)
					: undefined;
			if (lastAssistant && (info?.class === "output-limit" || info?.class === "combined-output-caused")) {
				// The output was learned at message_end; retry with it, bounded, and never shrink the window.
				if (outputRetries >= opts.maxOutputRetries || !lastOutputProgress) {
					log(
						`output-limit retry stopped (${outputRetries}/${opts.maxOutputRetries} retries${lastOutputProgress ? "" : ", no lower output to try"})`,
					);
					return undefined;
				}
				outputRetries++;
				stats.outputRetries++;
				const drafts: SessionBoundaryDraft[] = [
					...event.entries,
					{ type: "custom", customType: STATE_TYPE, data: snapshot(resolveLimits(ctx).key) },
				];
				const alreadyOmitted = !projection.some(
					(e) => e.sourceEntry.id === lastAssistant.id && e.messages.length > 0,
				);
				if (!alreadyOmitted) drafts.push({ type: "context_edit", targetId: lastAssistant.id, replacement: null });
				log(`output-limit retry ${outputRetries}/${opts.maxOutputRetries} (${info.class})`);
				return { entries: drafts, continue: true };
			}
			const failed = info?.class === "context-overflow" ? lastAssistant : undefined;
			if (failed && failed.type === "message") {
				if (overflowRetries >= opts.maxOverflowRetries) {
					log("overflow retry budget exhausted");
					return undefined;
				}
				overflowRetries++;
				stats.overflowRetries++;
				const drafts: SessionBoundaryDraft[] = [...event.entries];
				learnFromOverflow(resolveLimits(ctx), (failed.message as AssistantMessage).errorMessage, drafts, info);
				const alreadyOmitted = !projection.some((e) => e.sourceEntry.id === failed.id && e.messages.length > 0);
				if (!alreadyOmitted) drafts.push({ type: "context_edit", targetId: failed.id, replacement: null });
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
			hintedThisRun = false;
			outputRetries = 0;
			lastOutputProgress = true;
		});

		// H5: remember the prompt that starts each run; the header pins it. D2: a short prompt keeps the
		// pinned task and is carried as the latest instruction (with no task yet, it becomes the task).
		pi.on("before_agent_start", (event, ctx) => {
			if (!event.prompt) return;
			const prompt = event.prompt.slice(0, opts.taskMaxChars);
			const short = event.prompt.trim().length < opts.shortPromptChars;
			const kind = short && pinned(ctx.sessionManager.getBranch()).explicit ? "latest" : "run";
			pi.appendEntry(STATE_TYPE, { kind, prompt });
			log(`run prompt (${kind}, ${event.prompt.trim().length} chars)`);
		});

		// --------------------------------------------------------------- E1
		pi.on("session_before_compact", (event, ctx) => {
			stats.cancelledCompactions[event.reason] = (stats.cancelledCompactions[event.reason] ?? 0) + 1;
			if (event.reason !== "manual") return { cancel: true };
			// Manual /compact advances the window. No model call.
			const limits = resolveLimits(ctx);
			const ratio = ratioFor(limits.key);
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
				const { slots } = buildSlots(projection.entries, limits, ratio);
				const cut = readCut(branch);
				const start = cut
					? Math.max(
							0,
							slots.findIndex((s) => s.entryId === cut.firstKeptEntryId),
						)
					: 0;
				const system = getCurrentSystemMessage(projection.messages);
				const systemTokens = system ? messageTokens(system as AgentMessage) : 0;
				// P2b: with the pin on, the current cut's header is known exactly (no cut yet: the bound).
				const fixed =
					systemTokens +
					(opts.pinUserMessages && cut ? messageTokens(headerMessage(cut.header)) : headerTokens(branch));
				const current = (fixed + suffixSums(slots)[start]) * ratio;
				const seq = (cut?.seq ?? 0) + 1;
				const plan = chooseCut(
					branch,
					seq,
					systemTokens,
					(f) => chooseStart(slots, start, f, Math.min(opts.lowWater * limits.budget, current * 0.5), ratio, true),
					(s) => slots[s]?.entryId,
				);
				const next = plan.start;
				if (next > start) {
					const header = plan.header ?? makeHeader(seq, slots[next].entryId, branch);
					pi.appendEntry(STATE_TYPE, { kind: "cut", firstKeptEntryId: slots[next].entryId, seq, header });
					stats.cuts.push({ seq, mode: opts.mode, where: "manual", omitted: next, before: current, after: 0 });
					index = undefined;
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

		// --------------------------------------------------------------- E7 / H4 output clamp
		pi.on("before_provider_request", (event, ctx) => {
			const original = event.payload;
			if (!original || typeof original !== "object") return undefined;
			const payload = opts.notice && opts.noticeCacheSurgery ? moveCacheBreakpointOffNotice(original) : original;
			const moved = payload !== original;
			const limits = resolveLimits(ctx);
			const input = lastSent ? lastSent.estimate * ratioFor(limits.key) : 0;
			// A request may ask for more than the reserve when the actual request leaves room (H8).
			let allowed = Math.max(256, Math.min(limits.maxOutput, Math.floor(limits.hardWindow - input - 512)));
			// G1: the retry after an output-caused combined error asks for what the provider said is left.
			if (outputCapOnce !== undefined) {
				allowed = Math.min(allowed, outputCapOnce);
				outputCapOnce = undefined;
			}
			const next = { ...(payload as Record<string, unknown>) };
			let changed = false;
			let sent: number | undefined;
			const clamp = (holder: Record<string, unknown>, key: string) => {
				const value = holder[key];
				if (typeof value !== "number") return;
				// Only ever lower: cache-warming requests send 1 through this hook on purpose.
				if (value > allowed) {
					holder[key] = allowed;
					changed = true;
				}
				sent ??= holder[key] as number;
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
			lastOutputLimit = { sent, lowered: changed };
			const thinking = next.thinking as { budget_tokens?: number } | undefined;
			if (changed && thinking && typeof thinking.budget_tokens === "number" && typeof next.max_tokens === "number") {
				next.thinking = {
					...thinking,
					budget_tokens: Math.min(thinking.budget_tokens, Math.max(1024, (next.max_tokens as number) - 1)),
				};
			}
			if (!changed) return moved ? payload : undefined;
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
				"Read the verbatim content of a session entry by id (content shown truncated, images not shown, or messages that left the context window): text in pages, or one image by index.",
			parameters: Type.Object({
				entry: Type.String(),
				offset: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
				image: Type.Optional(Type.Number({ description: "Index of the content block holding the image." })),
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
				if (params.image !== undefined) {
					const block = Array.isArray(content) ? (content as Block[])[params.image] : undefined;
					if (!block || block.type !== "image")
						throw new Error(`Entry ${params.entry} has no image at index ${params.image}`);
					return {
						content: [
							{ type: "text", text: `[entry ${params.entry} image at index ${params.image}]` },
							block as ImageContent,
						],
						details: { entry: params.entry, image: params.image },
					};
				}
				const text = textOfContent(content);
				const limits = resolveLimits(ctx);
				const density = textTokens(text) / Math.max(1, text.length);
				const page = Math.min(
					params.limit ?? Number.POSITIVE_INFINITY,
					Math.floor((maxUnitTokens(limits) * 0.9) / Math.max(density, 0.05) / ratioFor(limits.key)),
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

		// R5: context_search. Case-insensitive search over the session's entries that are out of view (before
		// the current cut, omitted, or shown capped), or all entries; bounded output for context_recall.
		function searchEntries(
			ctx: ExtensionContext,
			query: string,
			scope: "out-of-view" | "all",
			limit: number,
		): { text: string; details: Record<string, unknown> } {
			const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
			if (terms.length === 0) throw new Error("Give at least one word to search for.");
			const branch = ctx.sessionManager.getBranch();
			const cut = readCut(branch);
			const keptFrom = cut ? branch.findIndex((e) => e.id === cut.firstKeptEntryId) : -1;
			const omitted = new Set(
				branch.flatMap((e) => (e.type === "context_edit" && e.replacement === null ? [e.targetId] : [])),
			);
			type Hit = { entry: string; role: string; turn: number; inView: boolean; capped: boolean; snippet: string };
			const hits: Hit[] = [];
			let assistants = 0;
			for (let i = 0; i < branch.length; i++) {
				const entry = branch[i];
				if (!contributesMessages(entry)) continue;
				let role: string = entry.type === "custom_message" ? `custom(${entry.customType})` : "branch summary";
				let text = "";
				if (entry.type === "message") {
					const message = entry.message as AgentMessage & { toolName?: string; content?: unknown };
					if (message.role === "system") continue;
					if (message.role === "assistant") assistants++;
					// The engine's own lookups are copies of other entries (or the query itself): skip them.
					if (
						message.role === "toolResult" &&
						(message.toolName === SEARCH_TOOL || message.toolName === RECALL_TOOL)
					)
						continue;
					if (
						message.role === "assistant" &&
						(message as AssistantMessage).content.some((b) => b.type === "toolCall" && b.name === SEARCH_TOOL)
					)
						continue;
					role = message.role === "toolResult" ? `tool result ${message.toolName}` : message.role;
					text = textOfContent(message.content);
				} else if (entry.type === "custom_message") text = textOfContent(entry.content);
				else if (entry.type === "branch_summary") text = entry.summary ?? "";
				const turn =
					entry.type === "message" && entry.message.role === "user" ? assistants + 1 : Math.max(1, assistants);
				const capped = decisions.has(entry.id);
				const inView = !(cut && keptFrom >= 0 && i < keptFrom) && !omitted.has(entry.id);
				if (scope === "out-of-view" && inView && !capped) continue;
				const lower = text.toLowerCase();
				if (!terms.every((t) => lower.includes(t))) continue;
				const at = lower.indexOf(terms[0]);
				const from = Math.max(0, at - 80);
				const snippet = `${from > 0 ? "…" : ""}${text
					.slice(from, at + 120)
					.replace(/\s+/g, " ")
					.trim()}${at + 120 < text.length ? "…" : ""}`;
				hits.push({ entry: entry.id, role, turn, inView, capped, snippet });
			}
			hits.reverse();
			const lines: string[] = [];
			let used = 0;
			const shown: Hit[] = [];
			for (const hit of hits) {
				if (shown.length >= limit) break;
				const where = hit.inView ? (hit.capped ? "in view, shown capped" : "in view") : "out of view";
				const line = `- ${hit.entry} · turn ${hit.turn} · ${hit.role} · ${where} · ${hit.snippet}`;
				if (used + line.length > opts.searchMaxChars && shown.length > 0) break;
				const clipped = line.length > opts.searchMaxChars ? `${line.slice(0, opts.searchMaxChars - 1)}…` : line;
				lines.push(clipped);
				used += clipped.length;
				shown.push(hit);
			}
			const head =
				`[${SEARCH_TOOL} "${query}" (${scope}): ${hits.length} ${hits.length === 1 ? "entry matches" : "entries match"}` +
				(hits.length > 0 ? `; ${shown.length} shown, newest first` : "") +
				(hits.length > shown.length ? `; ${hits.length - shown.length} more not shown: narrow the query` : "") +
				(shown.length > 0 ? `. Read one with ${RECALL_TOOL}({ "entry": "<id>" }).]` : ".]");
			return {
				text: [head, ...lines].join("\n"),
				details: {
					query,
					scope,
					total: hits.length,
					shown: shown.map(({ snippet: _s, ...rest }) => rest),
				},
			};
		}

		pi.registerTool({
			name: SEARCH_TOOL,
			label: "Context search",
			description:
				"Search this session's transcript for text that is no longer in your context: messages that left the window, and the parts of long results that are not shown. Case-insensitive; every word must occur in the entry. Returns entry ids, roles, turn numbers and short snippets, newest first; read an entry in full with context_recall.",
			parameters: Type.Object({
				query: Type.String({
					description: "Words to find (case-insensitive; an entry matches when it contains all of them).",
				}),
				scope: Type.Optional(
					Type.String({
						description: '"out-of-view" (default): only what you cannot see now; "all": every entry.',
					}),
				),
				limit: Type.Optional(Type.Number({ description: "At most this many results." })),
			}),
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				const scope = params.scope === "all" ? "all" : "out-of-view";
				const limit = Math.max(
					1,
					Math.min(opts.searchMaxResults, Math.floor(params.limit ?? opts.searchMaxResults)),
				);
				const { text, details } = searchEntries(ctx, params.query, scope, limit);
				return { content: [{ type: "text", text }], details };
			},
		});

		// --------------------------------------------------------------- P5
		const compactionEnabled = () => pi.getSettings().compaction?.enabled !== false;
		const refusal =
			"context-engine: refusing to run because compaction.enabled is not false (Pi's default is true). " +
			"With it on, Pi summarizes or drops context on its own paths before the engine is asked. " +
			'Add "compaction": { "enabled": false } to ~/.pi/agent/settings.json and restart.';

		pi.on("input", (_event, ctx) => {
			if (opts.onCompactionEnabled !== "fail") return undefined;
			if (!refused && !compactionEnabled()) return undefined;
			refused = true;
			stats.refused = true;
			ctx.ui.notify(refusal, "error");
			return { action: "handled" };
		});

		pi.on("session_start", (_event, ctx) => {
			loadState(ctx);
			lastRequestTokens = undefined;
			// D1: a setting can also mark the deployment as production.
			const settingsProduction =
				(pi.getSettings() as { penpi?: { production?: boolean } }).penpi?.production === true;
			let refusedNow = false;
			if (faults && settingsProduction) {
				faultsRefused = "the setting penpi.production";
				stats.faultsRefused = faultsRefused;
				stats.faultsActive = undefined;
				faults = undefined;
				refusedNow = true;
			}
			const banner = faultBanner();
			if (banner) {
				if (faults || refusedNow) {
					log(banner);
					console.warn(`[context-engine] ${banner}`);
				}
				ctx.ui.notify(`context-engine: ${banner}`, faults ? "warning" : "error");
			}
			updateStatus(ctx, resolveLimits(ctx));
			if (!compactionEnabled()) {
				refused = false;
				return;
			}
			if (opts.onCompactionEnabled === "warn") {
				ctx.ui.notify(
					"context-engine: set compaction.enabled to false; the engine cancels every compaction but Pi still omits a failed final attempt before asking.",
					"warning",
				);
				return;
			}
			refused = true;
			stats.refused = true;
			ctx.ui.notify(refusal, "error");
			ctx.shutdown();
		});
		pi.on("session_tree", (_event, ctx) => loadState(ctx));
	};
}

export default createContextEngine();
