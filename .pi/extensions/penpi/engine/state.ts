import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import type { AgentMessage } from "./estimator.ts";
import { type PinSource, STATE_TYPE, type TruncatedTurn } from "./options.ts";
import type { CapDecision } from "./planner.ts";
import { type FaultConfig, rng } from "./recovery.ts";
import type { SerializeTarget } from "./serializer.ts";

// ================================================================== state

/** System prompt sections by name, as Pi's system messages carry them: null removes a section. */
export type SectionMap = Record<string, string | null>;

export interface CutState {
	firstKeptEntryId: string;
	seq: number;
	header: string;
	/** When the cut was made (ms): the header's timestamp, so Pi's estimate ignores pre-cut usage. */
	at?: number;
	/** The header format the cut was made with (HEADER_FORMAT); missing in cut entries before it existed. */
	hv?: number;
	/**
	 * System prompt sections the host asked to change, in effect from this cut on (setSectionAtNextCut),
	 * cumulative over earlier cuts. Persisted in the cut entry, so a rebuilt window sends the same prompt.
	 */
	sections?: SectionMap;
}

export interface LearnedWindow {
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
	/**
	 * G2: plateau windows are kept for this session only (never exported). Re-probed only when below
	 * silentReprobeBelow of the planning window, at most silentReprobes times per session.
	 */
	scope?: "session";
	/** G2: answers produced from truncated input when the plateau was detected. */
	truncatedTurns?: TruncatedTurn[];
}

export interface ModelState {
	ratio: number;
	samples: number;
	history: Array<{ estimate: number; reported: number; ratio: number }>;
	/** G2: recent samples with their answer's timestamp, to name truncated turns. */
	recent: Array<{
		at: number;
		expected: number;
		reported: number;
		ratio: number;
		suspect?: string;
		/** D24: the upstream provider that served it, when the response named one. */
		provider?: string;
	}>;
	/** The previous successful sample (send sequence number and reported usage). */
	lastSample?: { seq: number; reported: number };
	/**
	 * D24: the upstream provider that served the previous sample, when the response names it (OpenRouter's
	 * `provider` field). Providers behind one route count tokens differently. Not persisted.
	 */
	servedBy?: string;
	/**
	 * D24: per upstream provider, its last sample (with its place in the append chain, for judging a switch
	 * sample against it), and the detector state of providers not serving now (their running maximum and
	 * evidence, set aside at a switch and restored when they serve again). Not persisted.
	 */
	providerLast?: Map<string, { seq: number; reported: number; chain: number; cum: number }>;
	providerParked?: Map<string, { maxReported: number; maxExpected?: number; suspects: ModelState["suspects"] }>;
	/** The largest usage reported by a sample that was not quarantined. */
	maxReported: number;
	/** The expectation of the sample that set maxReported (a repeat of the same request is no evidence). */
	maxExpected?: number;
	/** Quarantined samples (evidence of silent truncation), with the sample count when seen. */
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
	/** Re-probes of silent-learned windows so far in this session (persisted with the model state). */
	silentProbes: number;
	/** Answers from this model that reported no input usage (silent-truncation detection needs it). */
	noUsage?: number;
}

export interface Limits {
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
export interface Item {
	entryId: string;
	message: AgentMessage;
	out: AgentMessage;
	tokens: number;
	startable: boolean;
	system: boolean;
}

/** Mode a: the window from the cut onward, kept up to date from the leaf (H7). */
export interface WindowIndex {
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
	/** The serialize target the item tokens were estimated for (a different one rebuilds the index). */
	targetKey: string;
}

export type Carried = {
	id: string;
	text: string;
	/** D5: the text context_recall reads (textOfContent): offsets and lengths in the pin refer to it. */
	recall: string;
	images: string[];
	mode: "verbatim" | "head" | "pointer" | "range" | "image";
	current: boolean;
	source?: PinSource;
	agent: boolean;
	/** D26: the UTC day the message was sent (YYYY-MM-DD), when the entry has a timestamp. */
	day?: string;
};

export type PinDecision = { id: string; from: Carried["mode"]; to: Carried["mode"]; why: string };

/** The engine's mutable state for one extension instance (one session runtime). */
export function newEngineState(faults: FaultConfig | undefined) {
	return {
		models: new Map<string, ModelState>(),
		decisions: new Map<string, CapDecision>(),
		pendingDecisions: {} as Record<string, CapDecision>,
		outCache: new Map<string, { message: AgentMessage; out: AgentMessage }>(),
		/**
		 * The request just sent. `seq` numbers every request; `appendOnly` says its message list extends
		 * the previous request's (request-only notice tails excluded), `appendedText` is the estimate of the
		 * appended messages without images, `noticeDrop` the estimate of the previous request's notice,
		 * `afterLengthStop` that the appended messages include an answer cut at the output limit.
		 */
		lastSent: undefined as
			| {
					estimate: number;
					key: string;
					seq: number;
					appendOnly: boolean;
					appendedText: number;
					appendedReplay: number;
					appendedAsText: number;
					noticeDrop: number;
					afterLengthStop: boolean;
					/** D24: the append chain this request belongs to, and the text appended along it so far. */
					chain: number;
					cum: number;
			  }
			| undefined,
		sendSeq: 0,
		/**
		 * D24: the append chain. Consecutive append-only requests form one chain (a cut, a rebuild, any other
		 * request that is not append-only, or one right after a length stop starts the next); `appendCum` is the
		 * text appended along the chain.
		 * The usage difference between two samples of one chain should be about the difference of their sums.
		 */
		appendChain: 0,
		appendCum: 0,
		/** D25: per capped section, the cap (and window) the last request saw; reset at each session start. */
		sectionCapSeen: {} as Record<string, { cap: number; window: number }>,
		/** Whether this session's first aligned request has checked the latest cut's header format. */
		headerFormatChecked: false,
		/**
		 * The input source of each user message, by the message's timestamp. Recorded at the input
		 * event, persisted as a state entry ({ kind: "source", at, source }) when the user message ends, and
		 * reloaded from the branch, so resumes keep it.
		 */
		sources: new Map<number, PinSource>(),
		pendingInputs: [] as Array<{ source: PinSource; text: string; queued: boolean }>,
		/** Pinned-block tokens by block text (per-request sizes). */
		pinSizes: new Map<string, number>(),
		/** The window of the latest resolved limits (sizes the user-message pin). */
		lastWindow: 0,
		/** D9: the model the last limits were resolved for (the pin cap is compared in its provider tokens). */
		lastKey: "",
		/** What the latest resolved model serializes (budget and detector estimates). */
		target: undefined as SerializeTarget | undefined,
		targetKey: "",
		serialCache: new Map<string, WeakMap<object, { tokens: number; reasoning: number; asText?: number }>>(),
		/**
		 * The replay check (doctor, warn-only): per model, the share of the replayed reasoning that reported
		 * growth accounted for, over consecutive no-cut request pairs; and the models already warned about.
		 */
		replayShares: new Map<string, number[]>(),
		replayWarned: new Set<string>(),
		/** RC6: the tool-call repair kinds already logged (each is logged once). */
		repairsLogged: new Set<string>(),
		/** D24: the upstream provider named by the current response's stream (provider_stream_event), if any. */
		streamProvider: undefined as string | undefined,
		/** System prompt sections to change at the next cut, and those changed at a cut in this session (E8.14). */
		pendingSections: {} as SectionMap,
		appliedSections: {} as SectionMap,
		/** When each applied section took effect (ms): a system message newer than that supersedes it. */
		appliedAt: {} as Record<string, number>,
		/** The current model's replayed reasoning is left out of the budget (replayedReasoning "ignored"). */
		replayIgnored: false,
		sentShape: undefined as { keys: string[]; noticeTokens: number } | undefined,
		lastOutputLimit: undefined as { sent?: number; lowered: boolean } | undefined,
		overflowRetries: 0,
		lengthContinuations: 0,
		hintedThisRun: false,
		seqCache: 0,
		index: undefined as WindowIndex | undefined,
		refused: false,
		lastRequestTokens: undefined as number | undefined,
		// G1
		outputRetries: 0,
		outputCapOnce: undefined as number | undefined,
		lastOutputProgress: true,
		// G2: a plateau found at message_end is reported at turn_end, once the answer has an entry id.
		pendingPlateau: undefined as
			| { key: string; window: number; max: number; samples: ModelState["recent"]; probing?: boolean }
			| undefined,
		// D1
		responseCount: 0,
		faultRandom: rng(faults?.seed ?? 1),
		/** The latest rendered pins by header text (logged when a cut commits; sizes per request). */
		pinReports: new Map<string, { tokens: number; cap: number; carried: number; decisions: PinDecision[] }>(),
	};
}

export type EngineState = ReturnType<typeof newEngineState>;

export function installState(core: EngineCore): void {
	const { pi, opts, stats, log, st } = core;

	// ---------------------------------------------------------------- per-model state (H2)
	function modelState(key: string): ModelState {
		let state = st.models.get(key);
		if (!state) {
			// Unknown model: the densest known ratio is the safe prior (it under-sends until learned).
			const known = [...st.models.values()].filter((m) => m.samples > 0).map((m) => m.ratio);
			state = {
				ratio: Math.max(1, ...known),
				samples: 0,
				history: [],
				recent: [],
				maxReported: 0,
				suspects: [],
				output: { stops: [] },
				silentProbes: 0,
			};
			st.models.set(key, state);
		}
		return state;
	}
	core.modelState = modelState;

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
			silentProbes: s.silentProbes,
		};
	}
	core.snapshot = snapshot;

	function persistModel(key: string): void {
		pi.appendEntry(STATE_TYPE, snapshot(key));
	}
	core.persistModel = persistModel;

	function clampRatio(value: number): number {
		return Math.min(opts.ratioCeiling, Math.max(opts.ratioFloor, value));
	}
	core.clampRatio = clampRatio;

	function ratioFor(key: string): number {
		return opts.calibrate ? clampRatio(modelState(key).ratio) : 1;
	}
	core.ratioFor = ratioFor;

	function loadState(ctx: ExtensionContext): void {
		st.models.clear();
		st.decisions.clear();
		st.outCache.clear();
		st.index = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as Record<string, unknown> & { kind?: string };
			if (data.kind === "model" && typeof data.key === "string") {
				const learned = data.learned as LearnedWindow | undefined;
				const output = (data.output as ModelState["output"] | undefined) ?? { stops: [] };
				st.models.set(data.key, {
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
					silentProbes: Number(data.silentProbes ?? 0),
				});
			}
			if (data.kind === "caps" && data.decisions) {
				for (const [id, decision] of Object.entries(data.decisions as Record<string, CapDecision>))
					st.decisions.set(id, decision);
			}
		}
		st.seqCache = readCut(ctx.sessionManager.getBranch())?.seq ?? 0;
		st.sources.clear();
		st.pendingInputs = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as { kind?: string; at?: number; source?: PinSource };
			if (data.kind === "source" && typeof data.at === "number" && data.source) st.sources.set(data.at, data.source);
		}
		log(
			`state loaded models=${JSON.stringify([...st.models.entries()].map(([k, v]) => [k, +v.ratio.toFixed(3), v.samples, v.learned?.window]))} caps=${st.decisions.size} seq=${st.seqCache}`,
		);
	}

	/**
	 * D19: the sections of the cut entry at `index`. A cut records its sections only when they differ from
	 * the previous cut's on the branch; otherwise it says sectionsUnchanged, and they are that cut's.
	 */
	function cutSectionsAt(branch: SessionEntry[], index: number): SectionMap | undefined {
		for (let i = index; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as { kind?: string; sections?: SectionMap; sectionsUnchanged?: boolean };
			if (data.kind !== "cut") continue;
			if (data.sections) return data.sections;
			if (!data.sectionsUnchanged) return undefined;
		}
		return undefined;
	}

	/** D19: what a new cut entry records of `sections`: nothing, the sections, or that they are unchanged. */
	core.cutSectionsRecord = (branch, sections) => {
		if (!sections) return {};
		let latest = -1;
		for (let i = branch.length - 1; i >= 0 && latest < 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === STATE_TYPE &&
				(entry.data as { kind?: string }).kind === "cut"
			)
				latest = i;
		}
		const previous = latest >= 0 ? cutSectionsAt(branch, latest) : undefined;
		const same =
			previous !== undefined &&
			Object.keys(previous).length === Object.keys(sections).length &&
			Object.entries(sections).every(([name, text]) => name in previous && previous[name] === text);
		return same ? { sectionsUnchanged: true } : { sections };
	};

	/** Latest cut on the branch: a custom entry (mode a) or an engine compaction (b-compaction). */
	function readCut(branch: SessionEntry[]): CutState | undefined {
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as { kind?: string } & Partial<CutState>;
				if (data.kind === "cut" && data.firstKeptEntryId) {
					const sections = cutSectionsAt(branch, i);
					return {
						firstKeptEntryId: data.firstKeptEntryId,
						seq: data.seq ?? 0,
						header: data.header ?? "",
						at: Date.parse(entry.timestamp) + 1,
						...(typeof data.hv === "number" ? { hv: data.hv } : {}),
						...(sections ? { sections } : {}),
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
	core.readCut = readCut;

	pi.on("session_start", (_event, ctx) => {
		loadState(ctx);
		st.lastRequestTokens = undefined;
		// N6: the changes in effect carry over a session start (a resume, a reload) from the latest cut. Pi
		// records only a diff, so an unchanged host text records nothing and the cut's change still holds; a
		// system message recorded after the cut that sets a section is newer and wins for that section only
		// (pruneApplied, round 4: a diff of another section leaves the change in effect).
		st.pendingSections = {};
		st.sectionCapSeen = {};
		st.headerFormatChecked = false;
		st.appliedSections = {};
		st.appliedAt = {};
		const branch = ctx.sessionManager.getBranch();
		let cutAt = -1;
		let sections: SectionMap | undefined;
		for (let i = branch.length - 1; i >= 0 && cutAt < 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as { kind?: string };
				if (data.kind === "cut") {
					cutAt = i;
					sections = cutSectionsAt(branch, i);
				}
			}
		}
		if (sections) {
			st.appliedSections = { ...sections };
			const at = Date.parse(branch[cutAt].timestamp);
			for (const name of Object.keys(sections)) st.appliedAt[name] = at;
			core.pruneApplied(branch);
		}
		st.replayShares = new Map();
		st.replayWarned = new Set();
		// D1: fault injection is decided when the engine is created (PENPI_FAULTS, PENPI_PRODUCTION); a
		// refusal was printed then, an active switch is printed here.
		const banner = core.faultBanner();
		if (banner) {
			if (core.faults) {
				log(banner);
				console.warn(`[context-engine] ${banner}`);
			}
			ctx.ui.notify(`context-engine: ${banner}`, core.faults ? "warning" : "error");
		}
		core.updateStatus(ctx, core.resolveLimits(ctx));
		if (!core.compactionEnabled()) {
			st.refused = false;
			return;
		}
		if (opts.onCompactionEnabled === "warn") {
			ctx.ui.notify(
				"context-engine: set compaction.enabled to false; the engine cancels every compaction but Pi still omits a failed final attempt before asking.",
				"warning",
			);
			return;
		}
		st.refused = true;
		stats.refused = true;
		ctx.ui.notify(core.refusal, "error");
		ctx.shutdown();
	});
	pi.on("session_tree", (_event, ctx) => loadState(ctx));
}
