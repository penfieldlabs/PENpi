import type { FaultConfig, ProviderErrorClass } from "./recovery.ts";

/** Mode "a" (persistent window) is the only mode. */
export type EngineMode = "a";

/** Pi's InputSource (extensions/types.ts): where a user message came from. */
export type PinSource = "interactive" | "rpc" | "extension";

/** The user-message pin. Tokens are estimated (textTokens). */
export interface PinUserMessagesOptions {
	/** The pinned block stays within min(capFraction x planning window, capMaxTokens). */
	capFraction: number;
	/** Absolute cap (a 1M model with the ceiling disabled would otherwise carry 100k tokens of pin). */
	capMaxTokens: number;
	/** The session's first this-many carried messages are pointered last (standing instructions come first). */
	protectFirst: number;
	/** A user message longer than this (a paste) is carried as a pointer, not verbatim. */
	longMessageChars: number;
	/**
	 * Sources whose messages are pinned (Pi's InputSource, recorded at the input event and persisted).
	 * Default interactive and rpc: messages a person typed. "extension" adds messages extensions send.
	 */
	sources: PinSource[];
	/**
	 * User messages with no recorded source (older sessions, or a message whose input event the engine did
	 * not see). "pin" (default) carries them like any pinned message; "skip" leaves them out.
	 */
	unrecordedSource: "pin" | "skip";
	/**
	 * Messages starting with one of these prefixes were typed by an agent (a manager
	 * agent typing into the session's terminal arrives as interactive input). They are pinned with the
	 * label "from the manager agent, not typed by the user".
	 */
	agentPrefixes: string[];
}

/** The pin's default configuration (pinUserMessages: {} or a partial object fills in from this). */
export const PIN_DEFAULTS: PinUserMessagesOptions = {
	capFraction: 0.1,
	capMaxTokens: 20_000,
	protectFirst: 3,
	longMessageChars: 2_000,
	sources: ["interactive", "rpc"],
	unrecordedSource: "pin",
	agentPrefixes: ["[manager]"],
};

export interface EngineOptions {
	mode: EngineMode;
	/** Cut when the projected request exceeds this fraction of the input budget. */
	highWater: number;
	/** A cut keeps the projected request at or below this fraction of the input budget. */
	lowWater: number;
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
	/**
	 * Whether the provider counts the reasoning Pi replays, by "provider/modelId". "counted" (the
	 * default for any model not listed) budgets it; "ignored" leaves it out of the budget estimate for that
	 * model. Thinking Pi sends as text (requiresThinkingAsText) is always budgeted, and the silent-truncation
	 * detector never counts replayed reasoning either way. Whether a provider counts it depends on the model
	 * and the request options (current Claude models keep and count earlier thinking, older ones strip it), and
	 * under-counting risks rejections or silent truncation while over-counting only wastes window, so set
	 * "ignored" only on evidence: a measured calibration ratio pinned at the 0.8 floor with thinking on.
	 */
	replayedReasoning: Record<string, "counted" | "ignored">;
	/**
	 * H8: plan against min(model window, windowCeiling). 0 or null disables the ceiling. Default 200,000:
	 * long single tool outputs and long tasks have room. Planning against 100,000 matched 200,000 on quality
	 * in the benchmark at lower token use per step (billed cost pending the release benchmark); nothing above
	 * 200,000 was tested.
	 */
	windowCeiling: number | null;
	/** Name of the diagnostic command (`/<name> doctor`). */
	commandName: string;
	/** E3: false pins the ratio at 1. */
	calibrate: boolean;
	/** H1: bounds of the learned ratio (provider tokens per estimated token). */
	ratioFloor: number;
	ratioCeiling: number;
	/** H1/G2: two reported counts within this fraction are "the same"; also the naming tolerance. */
	plateauFlatness: number;
	/**
	 * Silent truncation: between two consecutive requests whose message list only grew, reported
	 * usage must grow by at least this fraction of the appended text's expected tokens (images excluded).
	 */
	silentShortfall: number;
	/** Appended text below this many expected tokens is too small to judge. */
	silentMinGrowth: number;
	/** No growth at all after appending at least this many expected tokens is strong evidence. */
	silentZeroGrowthFloor: number;
	/** Below this growth ratio (and above silentShortfall) a sample is no evidence but cannot clear evidence. */
	silentMarginal: number;
	/** A growth ratio below this, on an append of at least silentStrongGrowth tokens, is strong evidence. */
	silentStrongShortfall: number;
	silentStrongGrowth: number;
	/** The "no more than the largest usage" rule needs this many clean samples for the model first. */
	silentSettledSamples: number;
	/**
	 * Suspect samples needed among judged samples (strong ones too). Unjudged samples are skipped and
	 * never reset the count; only a clean sample above the running maximum clears the evidence.
	 */
	silentSuspects: number;
	/** Weak evidence older than this many samples is forgotten. */
	silentEvidenceSpan: number;
	/** H3: clean requests near a learned limit before a re-probe, and confirmations that end probing. */
	probeAfterParsed: number;
	probeAfterUnparsed: number;
	probeConfirmations: number;
	/** H6: tokens for an image whose size cannot be read; budget share images may hold after a cut. */
	defaultImageTokens: number;
	imageShare: number;
	/** Notice when the request is within this fraction of high water (or one turn's growth). */
	noticeFraction: number;
	/** False switches the pre-cut notice off entirely (nothing is sent or counted). Off by default. */
	notice: boolean;
	/** context_search returns at most this many hits and this many characters. */
	searchMaxResults: number;
	searchMaxChars: number;
	/** P5: "fail" refuses to run while compaction.enabled is not false; "warn" only warns (tests). */
	onCompactionEnabled: "fail" | "warn";
	maxLengthContinuations: number;
	/**
	 * D15: the continuation message after a length stop with no visible text and no tool call (the whole
	 * output limit went to reasoning, which Pi does not replay). "answer" asks for the answer or the next
	 * tool call directly; "continue" sends the ordinary continuation message.
	 */
	reasoningOnlyContinuation: "answer" | "continue";
	maxOverflowRetries: number;
	notesMaxChars: number;
	taskMaxChars: number;
	/** G1: retries per run after an output-limit or output-caused combined error. */
	maxOutputRetries: number;
	/** G1: the output step-down (error without a number) halves the request, never below this. */
	minOutputLimit: number;
	/** G3: true repeats the pre-cut notice on every request in the zone; false gives one per cut cycle. */
	noticeRepeats: boolean;
	/**
	 * Standing instructions: carry user messages that left the window in the header, verbatim, so
	 * instructions survive cuts without the model copying them into its notes. null = off (the H5 pinned
	 * task and latest instruction only). On by default (PIN_DEFAULTS); a partial object is completed from
	 * PIN_DEFAULTS.
	 */
	pinUserMessages: Partial<PinUserMessagesOptions> | null;
	/**
	 * Custom message types never sent to the model: kept in the session (and found by search), left out of
	 * every request and of the budget. A host lists the message kinds it has retired (PENpi: the 0.4
	 * orientation briefing, now a system prompt section, so resumed 0.4 sessions do not carry it twice).
	 */
	hiddenCustomTypes: string[];
	/**
	 * Re-probe a window learned from silent truncation only when it is below this fraction of the
	 * planning window, at most silentReprobes times per session.
	 */
	silentReprobeBelow: number;
	silentReprobes: number;
	/**
	 * Which of Pi's converters a model's requests go through, for the serializer estimate, by
	 * "provider/modelId" or by API name (for providers registered under their own API name that send
	 * through openai-completions, anthropic-messages or bedrock-converse-stream). Default: the model's API.
	 */
	serializeAs?: Record<string, string>;
	/** D1: fault injection (tests only), a FaultConfig or a PENPI_FAULTS spec; also read from PENPI_FAULTS. */
	faults?: FaultConfig | string | null;
	/** D1: marks a production deployment (fault injection is refused); also PENPI_PRODUCTION=1. Not a setting. */
	production?: boolean;
	/** Environment for PENPI_FAULTS and PENPI_PRODUCTION (default process.env). */
	env?: Record<string, string | undefined>;
	log?: (line: string) => void;
	/** Shared across reloads so tests can observe the engine. */
	stats?: EngineStats;
}

export interface EngineStats {
	cuts: Array<{ seq: number; mode: string; where: string; omitted: number; before: number; after: number }>;
	/** Pin on: per cut, the header size planned with (fixedAfter - base) and the header actually rendered. */
	headerPlans: Array<{ upper: number; planned: number; rendered: number; secondPass: boolean }>;
	/** Times the rendered header exceeded the upper bound (expected 0). */
	headerBoundMisses: number;
	guardTrims: number;
	capped: number;
	overflowRetries: number;
	lengthContinuations: number;
	/** D15: length stops with no visible text and no tool call that were continued. */
	reasoningOnlyStops: number;
	alignMismatches: number;
	/** D25: capped system prompt sections re-capped for a smaller window. */
	sectionRecaps: number;
	cancelledCompactions: Record<string, number>;
	calibrationSamples: number[];
	/** Per request: the budget estimate, the ratio and budget it was planned with, and the detector's appended estimate. */
	sent: Array<{ estimate: number; ratio: number; budget: number; appended?: number }>;
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
	/** The replay check's warnings: the setting disagreed with what the provider does. */
	/** The replay check so far, per model: qualifying request pairs and their median share. */
	replayChecks: Record<string, { pairs: number; median: number }>;
	replayWarnings: Array<{
		key: string;
		setting: "counted" | "ignored";
		observed: "counted" | "ignored";
		median: number;
		pairs: number;
	}>;
	limitResets: number;
	/** Per request, the estimated tokens of the pinned user-message block it carried (0: none). */
	pinTokens: number[];
	/** Every pointering decision of a committed pin (cut seq, entry, mode change, reason). */
	pinDecisions: Array<{ seq: number; id: string; from: string; to: string; why: string }>;
	/** User messages whose input source was recorded, by source. */
	inputSources: Record<string, number>;
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
	/** The answer came from a re-probe of a silent-learned window (the probe itself was truncated). */
	probe?: boolean;
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
		reasoningOnlyStops: 0,
		alignMismatches: 0,
		sectionRecaps: 0,
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
		replayChecks: {},
		replayWarnings: [],
		limitResets: 0,
		pinTokens: [],
		pinDecisions: [],
		inputSources: {},
	};
}

export const DEFAULTS: EngineOptions = {
	mode: "a",
	highWater: 0.75,
	lowWater: 0.45,
	maxUnitFraction: 0.25,
	outputReserveFraction: 0.2,
	defaultWindow: 32_768,
	defaultMaxOutput: 16_384,
	implausibleOutputFraction: 0.75,
	limitOverrides: {},
	replayedReasoning: {},
	windowCeiling: 200_000,
	commandName: "penpi",
	calibrate: true,
	ratioFloor: 0.8,
	ratioCeiling: 6,
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
	notice: false,
	searchMaxResults: 10,
	searchMaxChars: 4_000,
	onCompactionEnabled: "fail",
	maxLengthContinuations: 3,
	reasoningOnlyContinuation: "answer",
	maxOverflowRetries: 3,
	notesMaxChars: 4_000,
	taskMaxChars: 2_000,
	maxOutputRetries: 3,
	minOutputLimit: 1_024,
	noticeRepeats: false,
	pinUserMessages: PIN_DEFAULTS,
	hiddenCustomTypes: [],
	silentReprobeBelow: 0.25,
	silentReprobes: 2,
};

/** customType of the engine's state entries (custom, never in context). */
export const STATE_TYPE = "context-engine";
/**
 * The window header's format, recorded in each cut entry as `hv`. A cut entry without it (PENpi up to RC4) or with an
 * older one replays an older header, so the first aligned request of a session whose latest cut is older forces a cut,
 * which makes the header in the current format. 2: D26 (dated, labelled pin; the current-request line).
 */
export const HEADER_FORMAT = 2;

/** customType of the window header in mode "a" (a context-only custom message, never persisted). */
export const HEADER_TYPE = "context-engine.window";

export const NOTICE_TYPE = "context-engine.notice";

export const NOTICE_MARKER = "[context-engine notice]";

export const CONTINUE_TYPE = "context-engine.continue";

/** E6: the continuation message after a length stop that wrote visible text. */
export const LENGTH_CONTINUATION =
	"Your previous response reached the output token limit and was cut off. Continue exactly where it stopped, without repeating what you already wrote.";

/** D15: the continuation message after a length stop that produced only reasoning. */
export const REASONING_ONLY_CONTINUATION =
	"Your previous response used the whole output limit on reasoning and produced no answer; that reasoning is not available to you now. Give the answer or the next tool call directly, keeping the reasoning short.";

export const NOTES_TOOL = "context_notes";

export const RECALL_TOOL = "context_recall";

/** Text search over the session's entries that are out of view (or all of them). */
export const SEARCH_TOOL = "context_search";

/** PENpi's own tool that searches earlier session files (named in the header only when it is active). */
export const TRANSCRIPT_SEARCH_TOOL = "search_transcript";

/** 200000 -> "200k", 1048575 -> "1.05M". */
/**
 * A system prompt section as Pi stores and sends it (core/system-prompt.ts, buildSystemPromptSections): the
 * content between `<name>` and `</name>` lines. Pi does not export its wrapper; this is the one copy the engine
 * uses, and a test checks it against Pi's builder byte for byte.
 */
export function systemPromptSection(name: string, content: string): string | undefined {
	// Pi leaves an empty section out of the prompt.
	return content ? `<${name}>\n${content}\n</${name}>` : undefined;
}

export function kTokens(value: number): string {
	if (value >= 999_500) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return `${Math.round(value)}`;
}

/** D3: `defaults` with every override that is not undefined (undefined keeps the default; null is a value). */
export function withDefaults<T extends object>(defaults: T, overrides: Partial<T> | undefined): T {
	const out = { ...defaults };
	for (const [key, value] of Object.entries(overrides ?? {}))
		if (value !== undefined) (out as Record<string, unknown>)[key] = value;
	return out;
}

/**
 * The engine's options: the defaults, overridden by every option given that is not undefined (D3: a
 * config loader that maps a missing key to undefined must not switch off the pin or the 200k ceiling);
 * the pin's options completed from PIN_DEFAULTS the same way. Only null (or 0 where documented)
 * switches a feature off.
 */
export function resolveOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
	const opts = withDefaults(DEFAULTS, overrides);
	if (opts.pinUserMessages) opts.pinUserMessages = withDefaults(PIN_DEFAULTS, opts.pinUserMessages);
	return opts;
}
