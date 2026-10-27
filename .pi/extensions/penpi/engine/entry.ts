/**
 * The one place PENpi builds its context engine. The full extension (index.ts) and engine-only.ts (the
 * release-gate benchmark's entry point, without Penfield memory) both call installPenpiEngine, so the engine
 * reads the same settings with the same defaults in both. The only difference is wiring: in the full
 * extension, PENpi's own /penpi command routes `doctor` and `reset-limits` to the engine.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BRIEFING_CUSTOM_TYPE, loadPenpiSettings } from "../config.ts";
import { createContextEngine, type EngineHandle } from "./index.ts";
import { newStats } from "./options.ts";
import { engineOptionsFromSettings, retiredEnvWarnings } from "./settings.ts";
import { ENGINE_LOG_ENV, engineLogWriter, installTelemetry } from "./telemetry.ts";

export interface PenpiEngineSetup {
	/** The `penpi` settings block (default: read from the global settings). */
	settings?: Record<string, unknown>;
	/** Where PENPI_ENGINE_LOG is read from (default: process.env). */
	env?: Record<string, string | undefined>;
	/** Settings problems (default: stderr, as for PENpi's other settings). */
	warn?: (message: string) => void;
}

/** Install PENpi's context engine on `pi`; returns its handle once installed. */
export function installPenpiEngine(
	pi: ExtensionAPI,
	wiring: { registerCommand: boolean },
	setup: PenpiEngineSetup = {},
): EngineHandle {
	const warn = setup.warn ?? ((message: string) => console.error(`[PENpi] ${message}`));
	const options = engineOptionsFromSettings(setup.settings ?? (loadPenpiSettings() as Record<string, unknown>), warn);
	const env = setup.env ?? process.env;
	retiredEnvWarnings(env, warn);
	const logPath = env[ENGINE_LOG_ENV]?.trim();
	const writer = logPath ? engineLogWriter(logPath) : undefined;
	const stats = newStats();
	let handle: EngineHandle | undefined;
	createContextEngine(
		{
			...options,
			// The 0.4 orientation briefing message is a system prompt section now (index.ts); old sessions keep it.
			hiddenCustomTypes: [BRIEFING_CUSTOM_TYPE],
			stats,
			...(writer ? { log: writer.line } : {}),
		},
		{
			registerCommand: wiring.registerCommand,
			// PENpi's settings manager defaults compaction.enabled to false.
			compactionOffByDefault: true,
			onInstall: (installed) => {
				handle = installed;
			},
		},
	)(pi);
	// Opt-in only: without PENPI_ENGINE_LOG there is no log file and no telemetry status.
	if (writer) installTelemetry(pi, stats, writer.report);
	if (!handle) throw new Error("context engine did not install");
	return handle;
}
