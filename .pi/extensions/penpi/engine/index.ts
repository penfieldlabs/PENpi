import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { installDetector } from "./detector.ts";
import { setDefaultImageTokens, textTokens } from "./estimator.ts";
import { installHeader } from "./header.ts";
import { installLimits } from "./limits.ts";
import {
	type EngineOptions,
	type EngineStats,
	newStats,
	type PinUserMessagesOptions,
	resolveOptions,
	systemPromptSection,
} from "./options.ts";
import { installPin } from "./pin.ts";
import { installPlanner } from "./planner.ts";
import {
	describeFaults,
	FAULTS_ENV,
	type FaultConfig,
	installRecovery,
	PRODUCTION_ENV,
	parseFaultSpec,
} from "./recovery.ts";
import { installSerializer } from "./serializer.ts";
import { installState, newEngineState } from "./state.ts";
import { installDoctor } from "./tools/doctor.ts";
import { installNotes } from "./tools/notes.ts";
import { installRecall } from "./tools/recall.ts";
import { installSearch } from "./tools/search.ts";

export { imageSize, imageTokens, messageTokens, parseOverflow, textTokens } from "./estimator.ts";
export {
	CONTINUE_TYPE,
	type EngineMode,
	type EngineOptions,
	type EngineStats,
	HEADER_TYPE,
	LENGTH_CONTINUATION,
	NOTES_TOOL,
	NOTICE_MARKER,
	NOTICE_TYPE,
	newStats,
	PIN_DEFAULTS,
	type PinSource,
	type PinUserMessagesOptions,
	REASONING_ONLY_CONTINUATION,
	RECALL_TOOL,
	resolveOptions,
	SEARCH_TOOL,
	STATE_TYPE,
	systemPromptSection,
	TRANSCRIPT_SEARCH_TOOL,
	type TruncatedTurn,
} from "./options.ts";
export type { CapDecision } from "./planner.ts";
export {
	classifyProviderError,
	FAULTS_ENV,
	type FaultConfig,
	type FaultRule,
	MIN_OUTPUT_ROOM,
	PRODUCTION_ENV,
	type ProviderErrorClass,
	type ProviderErrorInfo,
	parseFaultSpec,
} from "./recovery.ts";
export { MODELLED_APIS, type SerializeTarget, serializedParts } from "./serializer.ts";
export type { EngineState } from "./state.ts";

/**
 * Context engine (PENpi 0.5.0; ADR 0032, docs/CONTEXT_ENGINE.md). A Pi extension that replaces
 * compaction with a persistent, monotone window. No LLM summarization is ever requested.
 * packages/coding-agent/test/suite/context-engine/BEHAVIOURS.md lists every behaviour with its configuration
 * and the test that proves it.
 *
 *   E1 compaction hard-off: cancels every session_before_compact reason (manual /compact advances the
 *      window instead), answers /tree summaries with a fixed notice. P5: refuses to run while the
 *      `compaction.enabled` setting is not false.
 *   E2 persistent window with hysteresis (mode "a"): a context_with_system handler applies a cut persisted
 *      in a custom entry, from an incremental index of the window (H7); system messages before the cut
 *      fold into a fixed checkpoint, later ones stay in place. Mode "a" is the only mode, and there is
 *      no notice cache surgery.
 *   E3 calibration from the request actually sent, per model (H2), relative to a character-class
 *      density estimator fitted on o200k_base and GLM tokenizers (H1, H6), with a ratio floor. A
 *      silent-truncation detector that needs no plateau: requests that only grew must report about what
 *      was appended; samples that do not are quarantined (they never move the ratio) and are evidence.
 *   E4 per-unit caps sized in estimated real tokens and frozen at first decision (H6), images included;
 *      everything stays recallable with `context_recall`.
 *   E5 overflow recovery at agent_before_settle; learned windows carry evidence and are re-probed (H3).
 *   E6 length continuation at turn_end; clamp-caused truncation raises the output limit, repeated
 *      stops at one output count teach the provider's real ceiling (H4).
 *   E7 effective limits: overrides, plausibility of metadata, default output 16,384 (H4).
 *   E8 pinned working notes and the pinned task (the prompt of the current run, H5) in the header.
 *   Shortly before a cut, a request-only notice at the tail names what will leave view; G3: once per
 *      cut cycle (noticeRepeats repeats it on every request).
 *   H8 plans against min(model window, windowCeiling = 200k); status line and `/penpi doctor`.
 *   G1 provider errors are classified before Pi's isContextOverflow: output-limit errors and combined
 *      (input + output) errors whose input fits teach the output ceiling or room and are retried,
 *      bounded, without shrinking the window.
 *   G2 a plateau names the answers produced from truncated input; `/penpi reset-limits`.
 *   D1 fault injection, a testing tool (PENPI_FAULTS, or the `faults` option in tests; not a setting), refused
 *      when PENPI_PRODUCTION=1.
 *   D10 one run record per prompt: every prompt becomes the pinned task (the pin carries earlier ones).
 *   `context_search` finds text that left the window; the header and notices name only active tools;
 *      `notice: false` switches the pre-cut notice off.
 *   Defaults: the user-message pin on (it replaces H5 and D2; only messages a person typed, the current
 *      request marked, cap min(10% of the window, 20,000)), the pre-cut notice off, the 200k ceiling.
 *      Budget and detector estimate what Pi serializes per API (serializedParts); the detector leaves all
 *      replayed reasoning out and acts on the second judged suspect (cleared only by a clean sample above
 *      the running maximum); a silent-learned window below 25% of the planning window is re-probed at
 *      most twice per session.
 */

/** How a host wires the engine. Nothing here changes what the engine does, only where it is reachable. */
export interface EngineWiring {
	/** Register `/<commandName>` (default true). PENpi registers /penpi itself and routes to the handle. */
	registerCommand?: boolean;
	/** Called once the engine is installed on an extension instance. */
	onInstall?: (handle: EngineHandle) => void;
	/**
	 * The host turns compaction off when `compaction.enabled` is unset (PENpi's fork default). Stock Pi
	 * defaults it to on, so without this an unset value counts as on and the engine refuses to run.
	 */
	compactionOffByDefault?: boolean;
}

/** An installed engine, for its host. */
export interface EngineHandle {
	/** `doctor` and `reset-limits`, as `/penpi` runs them. */
	command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	/** The resolved options the engine runs with. */
	options: EngineOptions;
	stats: EngineStats;
	/**
	 * Change a system prompt section at the engine's next cut, and keep it from then on, so the prompt changes
	 * only where the window does (E8.14). `content` is what a host sets in `systemPromptOptions.sections`; the
	 * engine wraps it in the section's tags as Pi does (systemPromptSection). The host keeps setting its
	 * session-start text in before_agent_start; the engine sends the newer one. A later call before the cut
	 * replaces the pending content.
	 */
	setSectionAtNextCut: (name: string, content: string) => void;
	/** The content the engine sends for a section changed at a cut in this session, if any (unwrapped). */
	appliedSection: (name: string) => string | undefined;
	/**
	 * D18: the engine cannot cut the system prompt, so a host caps a large section itself. `cap` is
	 * min(fraction x the planning window, maxTokens) for the current model; `tokens` is the engine's
	 * calibrated estimate of a section with that content, wrapped as Pi sends it.
	 */
	sectionCap: (
		ctx: ExtensionContext,
		name: string,
		fraction: number,
		maxTokens: number,
	) => { cap: number; tokens: (content: string) => number };
	/**
	 * D25: keep a section within min(fraction x the planning window, maxTokens) when the window shrinks (a smaller
	 * model, a learned window, a resume on a smaller model). Before each request the engine checks, in its calibrated
	 * estimate (more tokens than the cap is over):
	 * - a pending section (setSectionAtNextCut) over the cap: composed again with `recompose`, still for the next cut;
	 * - the section in effect, when the cap is below the one the last request saw (or it is the session's first
	 *   request) and the section is over the new cap: composed again and applied at a cut made at that request,
	 *   recorded in the cut entry. On a request the engine cannot align, the composed section is sent with Pi's
	 *   messages, and the next aligned request makes that cut.
	 */
	capSection: (
		name: string,
		fraction: number,
		maxTokens: number,
		recompose: (cap: { cap: number; tokens: (content: string) => number }) => string | undefined,
	) => void;
	/** A host line in the engine log (PENPI_ENGINE_LOG), prefixed like the engine's own; no-op without the log. */
	log: (line: string) => void;
	/** A line the host adds to `/penpi doctor`, rendered each time doctor runs. */
	addDoctorLine: (render: () => string) => void;
}

export function createContextEngine(
	overrides: Partial<EngineOptions> = {},
	wiring: EngineWiring = {},
): ExtensionFactory {
	const opts = resolveOptions(overrides);
	/** The pin's options completed from PIN_DEFAULTS (null: off). */
	const pinOpts = opts.pinUserMessages as PinUserMessagesOptions | null;
	const stats = opts.stats ?? newStats();
	const log = (line: string) => opts.log?.(`[${opts.mode}] ${line}`);
	setDefaultImageTokens(opts.defaultImageTokens);

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
	const bannerFor = (active: FaultConfig | undefined, refused: string | undefined) =>
		active
			? `FAULT INJECTION ACTIVE (${describeFaults(active)}): the engine turns some successful responses into errors or length stops. Never use this in production.`
			: refused
				? `FAULT INJECTION REFUSED: ${refused} marks this deployment as production; ${opts.faults ? "the faults option" : FAULTS_ENV} is ignored.`
				: undefined;
	const faultBanner = () => bannerFor(faults, faultsRefused);
	if (faults) stats.faultsActive = describeFaults(faults);
	if (faultsRefused) stats.faultsRefused = faultsRefused;
	// A refusal is announced now; an active switch at session start.
	if (faultsRefused) {
		log(faultBanner()!);
		console.warn(`[context-engine] ${faultBanner()}`);
	}

	return (pi: ExtensionAPI) => {
		const st = newEngineState(faults);
		const core = { pi, opts, stats, log, pinOpts, st, faults, faultsRefused, wiring } as EngineCore;
		core.cappedSections = new Map();
		core.hostDoctorLines = [];
		core.faultBanner = () => bannerFor(core.faults, core.faultsRefused);
		installSerializer(core);
		installState(core);
		installLimits(core);
		installHeader(core);
		installPin(core);
		installPlanner(core);
		installDoctor(core);
		installRecovery(core);
		installDetector(core);
		installNotes(core);
		installRecall(core);
		installSearch(core);
		wiring.onInstall?.({
			command: (args, ctx) => core.command(args, ctx),
			options: opts,
			stats,
			setSectionAtNextCut: (name, content) => {
				// An empty content removes the section, as Pi leaves an empty one out (null in a system message).
				st.pendingSections[name] = systemPromptSection(name, content) ?? null;
			},
			appliedSection: (name) => {
				const wrapped = st.appliedSections[name];
				if (wrapped === null) return "";
				const open = `<${name}>\n`;
				const close = `\n</${name}>`;
				return wrapped?.startsWith(open) && wrapped.endsWith(close)
					? wrapped.slice(open.length, wrapped.length - close.length)
					: wrapped;
			},
			log,
			addDoctorLine: (render) => {
				core.hostDoctorLines.push(render);
			},
			capSection: (name, fraction, maxTokens, recompose) => {
				core.cappedSections.set(name, { fraction, maxTokens, recompose });
			},
			sectionCap: (ctx, name, fraction, maxTokens) => {
				const limits = core.resolveLimits(ctx);
				const ratio = core.ratioFor(limits.key);
				return {
					cap: Math.min(Math.floor(fraction * limits.window), maxTokens),
					tokens: (content) => Math.ceil(textTokens(systemPromptSection(name, content) ?? "") * ratio),
				};
			},
		});
	};
}
