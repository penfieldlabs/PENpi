/**
 * The E2 matrix: mix x tokenizer x window x mode = 4 x 2 x 3 x 3 = 72 runs, narrowed by environment:
 *   E2_MIXES=coding,research,cjk,data  E2_TOKENIZERS=o200k,glm  E2_WINDOWS=32k,128k,1m
 *   E2_MODES=reject,silent-front,silent-messages  E2_TURNS=500  E2_SEED=1
 *   E2_SILENT_LIMIT=half|window|<fraction>   (default half, see below)
 *   E2_ENGINE_OPTIONS='{"windowCeiling":200000}'  extra createContextEngine options
 *   E2_SYSTEM_SECTION_TOKENS=6000  a system prompt section of about that many tokens (PENpi's briefing)
 *
 * P3 (B5): mode "reasoning" (default on, so the r5 false positive is a matrix regression): an honest provider
 *   (as reject) in front of a reasoning model, E2_THINKING=minimal|high, E2_REASONING_COUNT=sent|ignored|misconfigured;
 *   see runner.ts. The default matrix is 4 x 2 x 3 x 4 = 96 runs; E2_MODES=reject,silent-front,silent-messages
 *   gives the 72 runs of r5.
 * Modes (what the provider does above its hard limit):
 *   reject           answers with an overflow error; the limit is the model's declared window (an honest
 *                    provider), so any rejection means the engine sent more real tokens than the model holds.
 *   silent-front     drops tokens from the front (Ollama: keeps 4 head tokens) and reports exactly the limit.
 *   silent-messages  drops whole oldest messages after the system prompt and reports the real remainder.
 * Silent server limit: "half" (default) = min(window, 200k) / 2, a server whose context is below the model's
 * declared window (Ollama/llama.cpp num_ctx), so the engine's normal band crosses it and a detector has
 * something to detect. "window" is the literal variant (the declared window, as in reject): truncation then
 * only happens if the engine overshoots the window.
 * Error style (reject mode) rotates over runs so each style meets each tokenizer and window:
 *   ERROR_STYLES[(mix + window + tokenizer index) % 3].
 */
import { MIXES, type MixName } from "./mixes.ts";
import { ERROR_STYLES } from "./provider-sim.ts";
import {
	DESIGN_CEILING,
	isSilent,
	RUN_MODES,
	type RunConfig,
	type RunMode,
	THINKING,
	type ThinkingLevel,
	truncationOf,
	WINDOWS,
	type WindowName,
} from "./runner.ts";
import { TOKENIZERS, type TokenizerName } from "./tokenizers.ts";

const WINDOW_NAMES: WindowName[] = ["32k", "128k", "1m"];

function list<T extends string>(env: string | undefined, all: readonly T[]): T[] {
	if (!env) return [...all];
	const wanted = env
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const w of wanted)
		if (!all.includes(w as T)) throw new Error(`E2: unknown value "${w}" (expected ${all.join(", ")})`);
	return all.filter((x) => wanted.includes(x));
}

export function silentLimit(window: WindowName): { limit: number; rule: string } {
	const declared = WINDOWS[window].contextWindow;
	const planning = Math.min(declared, DESIGN_CEILING);
	const rule = process.env.E2_SILENT_LIMIT ?? "half";
	if (rule === "window") return { limit: declared, rule: "silent server holds the declared window" };
	const fraction = rule === "half" ? 0.5 : Number(rule);
	if (!(fraction > 0 && fraction <= 1)) throw new Error(`E2_SILENT_LIMIT: "${rule}" (half, window or a fraction)`);
	return {
		limit: Math.floor(planning * fraction),
		rule: `silent server holds ${fraction} x min(declared ${declared}, ${DESIGN_CEILING})`,
	};
}

/**
 * E2_REASONING_COUNT=ignored: the simulated provider ignores replayed reasoning, and the model is configured to
 * match (replayedReasoning: "ignored" on faux/e2-<window>), so the run checks the engine's handling of such a
 * provider rather than only the simulator. E2_REASONING_COUNT=misconfigured: the provider counts it and the
 * model is set to "ignored" anyway (the replay check must warn; summarize.mjs checks that it did). The run's
 * config records the setting.
 */
function replayIgnored(mode: RunMode, window: string, options: Record<string, unknown>): Record<string, unknown> {
	const count = process.env.E2_REASONING_COUNT;
	if (mode !== "reasoning" || (count !== "ignored" && count !== "misconfigured")) return options;
	const replayed = (options.replayedReasoning as Record<string, string> | undefined) ?? {};
	return { ...options, replayedReasoning: { ...replayed, [`faux/e2-${window}`]: "ignored" } };
}

export function matrixConfigs(onlyMix?: MixName): RunConfig[] {
	const mixes = list(process.env.E2_MIXES, MIXES).filter((m) => !onlyMix || m === onlyMix);
	const tokenizers = list(process.env.E2_TOKENIZERS, TOKENIZERS);
	const windows = list(process.env.E2_WINDOWS, WINDOW_NAMES);
	const modes = list(process.env.E2_MODES, RUN_MODES);
	const turns = Number(process.env.E2_TURNS ?? 500);
	const seed = Number(process.env.E2_SEED ?? 1);
	const thinking = (process.env.E2_THINKING ?? "minimal") as ThinkingLevel;
	if (!(thinking in THINKING)) throw new Error(`E2_THINKING: "${thinking}" (minimal or high)`);
	const engineOptions = process.env.E2_ENGINE_OPTIONS
		? (JSON.parse(process.env.E2_ENGINE_OPTIONS) as Record<string, unknown>)
		: {};
	// E2_SYSTEM_SECTION_TOKENS=N: a system prompt section of about N tokens on every run, as PENpi's briefing
	// is (<penpi-memory>): the budget and the header cap must hold with it (spec, before the RC, item 3).
	const sectionTokens = process.env.E2_SYSTEM_SECTION_TOKENS ? Number(process.env.E2_SYSTEM_SECTION_TOKENS) : 0;
	if (!(sectionTokens >= 0)) throw new Error(`E2_SYSTEM_SECTION_TOKENS: "${process.env.E2_SYSTEM_SECTION_TOKENS}"`);
	const configs: RunConfig[] = [];
	for (const mix of mixes)
		for (const tokenizer of tokenizers)
			for (const window of windows)
				for (const mode of modes) {
					const styleIndex =
						(MIXES.indexOf(mix) + WINDOW_NAMES.indexOf(window) + TOKENIZERS.indexOf(tokenizer as TokenizerName)) %
						3;
					const silent = isSilent(mode) ? silentLimit(window) : undefined;
					configs.push({
						id: `${mix}.${tokenizer}.${window}.${mode}${mode === "reasoning" ? `-${thinking}${process.env.E2_REASONING_COUNT === "ignored" ? "-ignored" : process.env.E2_REASONING_COUNT === "misconfigured" ? "-misconfigured" : ""}` : ""}${sectionTokens ? `.section${sectionTokens}` : ""}`,
						mix,
						tokenizer,
						window,
						mode,
						turns,
						seed,
						errorStyle: ERROR_STYLES[styleIndex],
						truncation: truncationOf(mode),
						limit: silent?.limit ?? WINDOWS[window].contextWindow,
						limitRule: silent?.rule ?? "provider rejects above the declared window",
						engineOptions: replayIgnored(mode, window, engineOptions),
						...(mode === "reasoning" ? { thinking } : {}),
						...(sectionTokens ? { systemSectionTokens: sectionTokens } : {}),
						...(mode === "reasoning" && process.env.E2_REASONING_COUNT === "misconfigured"
							? { replayMisconfigured: true }
							: {}),
					});
				}
	return configs;
}
