import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProjectedSessionEntry,
	SessionBoundaryDraft,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./estimator.ts";
/** What the engine's modules share: the instance's state and the functions one module calls in another. */
import type { EngineWiring } from "./index.ts";
import type { EngineOptions, EngineStats, PinUserMessagesOptions } from "./options.ts";
import type { FaultConfig, ProviderErrorInfo } from "./recovery.ts";
import type { CutState, EngineState, Item, Limits, ModelState, PinDecision, SectionMap } from "./state.ts";

/** D25: a host's capped system prompt section (EngineHandle.capSection). */
export interface CappedSection {
	fraction: number;
	maxTokens: number;
	/** The content for a cap, in the engine's calibrated estimate; undefined when the host has none. */
	recompose: (cap: { cap: number; tokens: (content: string) => number }) => string | undefined;
}

export interface EngineCore {
	pi: ExtensionAPI;
	opts: EngineOptions;
	stats: EngineStats;
	log: (line: string) => void;
	pinOpts: PinUserMessagesOptions | null;
	st: EngineState;
	faults: FaultConfig | undefined;
	faultsRefused: string | undefined;
	faultBanner: () => string | undefined;
	/** How the host wires the engine (not an engine option: it does not change what the engine does). */
	wiring: EngineWiring;
	/** `/penpi doctor` and `/penpi reset-limits`. */
	command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	parts: (message: AgentMessage) => { tokens: number; reasoning: number; asText?: number };
	sendTokens: (message: AgentMessage) => number;
	modelState: (key: string) => ModelState;
	snapshot: (key: string) => Record<string, unknown>;
	persistModel: (key: string) => void;
	clampRatio: (value: number) => number;
	ratioFor: (key: string) => number;
	readCut: (branch: SessionEntry[]) => CutState | undefined;
	/** The section overrides a cut puts into effect (this session's, with the pending ones); previewed, or taken. */
	sectionsAtCut: (take: boolean) => SectionMap | undefined;
	/**
	 * D25: system prompt sections a host caps relative to the planning window (EngineHandle.capSection), by name:
	 * the cap, and how to compose the section's content for a cap.
	 */
	cappedSections: Map<string, CappedSection>;
	/** D19: what a new cut entry records of these sections (nothing, them, or that they are unchanged). */
	cutSectionsRecord: (
		branch: SessionEntry[],
		sections: SectionMap | undefined,
	) => { sections?: SectionMap; sectionsUnchanged?: true };
	/** Drop applied sections that a system message recorded after them sets again (Pi's newer text wins). */
	pruneApplied: (branch: SessionEntry[]) => void;
	/** The system prompt of these system messages with an override made at `at` (later messages win). */
	systemWith: (
		systems: AgentMessage[],
		override: { sections?: SectionMap; at?: number } | undefined,
	) => AgentMessage | undefined;
	/** Window items with the overridden sections removed from system messages older than the override. */
	stripOverridden: (items: Item[], override: { sections?: SectionMap; at?: number } | undefined) => void;
	perModel: Record<string, { contextWindow?: number; maxTokens?: number }>;
	ceiling: number | undefined;
	resolveLimits: (ctx: ExtensionContext) => Limits;
	maxUnitTokens: (limits: Limits) => number;
	hasTool: (name: string) => boolean;
	pinCap: () => number;
	pinnedUserBlock: (
		branch: SessionEntry[],
		firstKeptEntryId: string,
	) => { block: string; report: { tokens: number; cap: number; carried: number; decisions: PinDecision[] } };
	logPin: (header: string, seq: number) => void;
	pinUpperTokens: (branch: SessionEntry[]) => number;
	/** D26: the header's current-request line at a cut ("" when the run has none); `longest` for a size bound. */
	currentRequestLine: (branch: SessionEntry[], firstKeptEntryId: string, longest?: boolean) => string;
	makeHeader: (seq: number, firstKeptEntryId: string, branch: SessionEntry[], withPin?: boolean) => string;
	headerMessage: (header: string, at?: number) => AgentMessage;
	headerTokens: (branch: SessionEntry[]) => number;
	chooseCut: (
		branch: SessionEntry[],
		seq: number,
		base: number,
		choose: (fixedAfter: number) => number,
		entryAt: (start: number) => string | undefined,
	) => { start: number; fixedAfter: number; header?: string };
	suffixSums: (items: Array<{ tokens: number }>) => number[];
	chooseStart: (
		items: Item[],
		from: number,
		fixedTokens: number,
		targetTokens: number,
		ratio: number,
		strictlyAfter?: boolean,
	) => number;
	updateStatus: (ctx: ExtensionContext, limits: Limits) => void;
	learnOutputCeiling: (limits: Limits, info: ProviderErrorInfo) => string;
	learnOutputRoom: (limits: Limits, info: ProviderErrorInfo) => string;
	recordSource: (message: AgentMessage & { timestamp?: number }) => void;
	requestPinTokens: (messages: AgentMessage[]) => number;
	calibrate: (assistant: AssistantMessage, ctx: ExtensionContext) => void;
	reportPlateau: (ctx: ExtensionContext, drafts: SessionBoundaryDraft[]) => void;
	/** The replay check so far for a model: request pairs judged and their median share. */
	replayCheck: (key: string) => {
		pairs: number;
		median: number | undefined;
		verdict: "counted" | "ignored" | undefined;
		/** What the check recommends for the setting (it warns once), from REPLAY_CHECK_PAIRS pairs on. */
		recommendation: "counted" | "ignored" | undefined;
	};
	buildSlots: (
		entries: ProjectedSessionEntry[],
		limits: Limits,
		ratio: number,
	) => { slots: Item[]; overhead: AgentMessage[] };
	learnFromOverflow: (
		limits: Limits,
		errorMessage: string | undefined,
		drafts: SessionBoundaryDraft[],
		info?: ProviderErrorInfo,
	) => number;
	compactionEnabled: () => boolean;
	refusal: string;
}
