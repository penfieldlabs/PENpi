/**
 * Engine switch for the engine tests. CONTEXT_ENGINE_BASELINE=1 loads the frozen copy delivered in round 1
 * (reference/r1-context-engine.ts, or CONTEXT_ENGINE_BASELINE_PATH); anything else loads the engine PENpi ships
 * (.pi/extensions/penpi/engine).
 * Exports that the baseline lacks are undefined there; tests must not depend on them for verdicts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Engine from "../../../../../.pi/extensions/penpi/engine/index.ts";

const FROZEN =
	process.env.CONTEXT_ENGINE_BASELINE_PATH ??
	join(dirname(fileURLToPath(import.meta.url)), "reference", "r1-context-engine.ts");
export const ENGINE_LABEL = process.env.CONTEXT_ENGINE_BASELINE === "1" ? "baseline" : "revised";

/**
 * The frozen file sits outside any tsconfig, which the test transformer requires, so the baseline is
 * loaded from a byte-identical copy next to this file (checked by SHA-256 on every load).
 */
function baselinePath(): string {
	const source = readFileSync(FROZEN);
	const copy = join(dirname(fileURLToPath(import.meta.url)), ".baseline", "context-engine.ts");
	mkdirSync(dirname(copy), { recursive: true });
	writeFileSync(copy, source);
	const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
	if (hash(readFileSync(copy)) !== hash(source)) throw new Error("baseline copy differs from the frozen engine");
	return copy;
}

/** The engine PENpi ships. Absolute: Vite resolves an ignored dynamic import's relative path from its root. */
const SHIPPED = fileURLToPath(new URL("../../../../../.pi/extensions/penpi/engine/index.ts", import.meta.url));
export const ENGINE_PATH = ENGINE_LABEL === "baseline" ? baselinePath() : SHIPPED;

const engine = (await import(/* @vite-ignore */ ENGINE_PATH)) as typeof Engine;

export const createContextEngine = engine.createContextEngine;
export const newStats = engine.newStats;
export const textTokens = engine.textTokens;
export const messageTokens = engine.messageTokens;
export const NOTICE_MARKER = engine.NOTICE_MARKER;
export const parseOverflow = engine.parseOverflow;
export const STATE_TYPE = engine.STATE_TYPE;
export const HEADER_TYPE = engine.HEADER_TYPE;
export const CONTINUE_TYPE = engine.CONTINUE_TYPE;
// Port (undefined on the baseline).
export const LENGTH_CONTINUATION = engine.LENGTH_CONTINUATION;
export const REASONING_ONLY_CONTINUATION = engine.REASONING_ONLY_CONTINUATION;
export const resolveOptions = engine.resolveOptions;
export const PIN_DEFAULTS = engine.PIN_DEFAULTS;
export const NOTES_TOOL = engine.NOTES_TOOL;
export const RECALL_TOOL = engine.RECALL_TOOL;
// Round 4 (undefined on the baseline).
export const classifyProviderError = engine.classifyProviderError;
export const parseFaultSpec = engine.parseFaultSpec;
export const FAULTS_ENV = engine.FAULTS_ENV ?? "PENPI_FAULTS";
export const PRODUCTION_ENV = engine.PRODUCTION_ENV ?? "PENPI_PRODUCTION";
export const MIN_OUTPUT_ROOM = engine.MIN_OUTPUT_ROOM;
// Round 5 (undefined on the baseline).
export const SEARCH_TOOL = engine.SEARCH_TOOL ?? "context_search";
export const NOTICE_TYPE = engine.NOTICE_TYPE ?? "context-engine.notice";
export type {
	EngineMode,
	EngineOptions,
	EngineStats,
	FaultConfig,
	ProviderErrorClass,
	ProviderErrorInfo,
	TruncatedTurn,
} from "../../../../../.pi/extensions/penpi/engine/index.ts";
