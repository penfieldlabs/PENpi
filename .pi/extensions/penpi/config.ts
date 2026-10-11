/**
 * PENpi configuration.
 *
 * Precedence (low → high): built-in defaults → the `penpi` key of the GLOBAL pi
 * settings.json (agent dir) → environment variables. A project .pi/settings.json
 * is never read: PENpi reads settings itself, outside pi's project-trust gate, so
 * any project layer would let an untrusted repository reconfigure it.
 *
 * Production is the default; an internal selector supports development.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PenfieldEnv = "dev" | "prod";
export type AuthMode = "apiKey" | "deviceCode";

export interface PenfieldConfig {
	env: PenfieldEnv;
	/** MCP Streamable-HTTP endpoint. */
	mcpUrl: string;
	/** REST API base. */
	apiBase: string;
	/** OAuth base. */
	authBase: string;
	/** Internal API-key exchange or the shipping RFC 8628 device-code path. */
	authMode: AuthMode;
	apiKey?: string;
	clientId?: string;
	tokenStorePath: string;
	scope: string;
}

/** customType of the orientation briefing, injected at session_start. */
export const BRIEFING_CUSTOM_TYPE = "penpi-briefing";

/** PENpi behavior knobs (FIFO watermarks, shutdown, adapter lifecycle). */
export interface PenpiConfig {
	contextCeiling: number;
	contextFloor: number;
	saveContextOnShutdown: boolean;
	/** Advanced diagnostic control: inject automatic orientation into model context. */
	injectBriefing: boolean;
	/**
	 * Render the injected briefing in the UI as well (default false).
	 * Orthogonal to `injectBriefing`: that decides whether the model receives automatic
	 * orientation; this decides whether the user also sees it.
	 */
	displayBriefing: boolean;
	/**
	 * Emergency fallback: consecutive settled agent runs without a valid context
	 * window (FIFO inactive) before PENpi forces a compaction. See ADR 0025.
	 */
	emergencyCompactionRuns: number;
}

interface PenpiSettings {
	penfield?: { env?: string; apiKey?: string; apiKeyFile?: string; clientId?: string; tokenStore?: string };
	contextCeiling?: number;
	contextFloor?: number;
	saveContextOnShutdown?: boolean;
	injectBriefing?: boolean;
	displayBriefing?: boolean;
	emergencyCompactionRuns?: number;
	mcpLifecycle?: string;
}

function hostFor(env: PenfieldEnv, sub: string): string {
	return env === "dev" ? `https://${sub}-dev.penfield.app` : `https://${sub}.penfield.app`;
}

function expandHome(p: string): string {
	return p.replace(/^~(?=$|\/)/, homedir());
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/**
 * Read `penpi` from the global agent settings only. A `penpi` block in the project
 * .pi/settings.json is ignored, with a warning so a user who put settings there
 * learns why they have no effect.
 */
function loadPenpiSettings(): PenpiSettings {
	const globalPath = resolve(piAgentDir(), "settings.json");
	const projectPath = resolve(process.cwd(), ".pi", "settings.json");
	if (projectPath !== globalPath && readJson(projectPath)?.penpi !== undefined) {
		console.error(
			`[PENpi] ignoring the "penpi" block in ${projectPath} — PENpi settings are global-only ` +
				`(${globalPath}), so a repository cannot reconfigure PENpi.`,
		);
	}
	return (readJson(globalPath)?.penpi as PenpiSettings | undefined) ?? {};
}

/** An environment variable's value, or undefined when unset or blank: `export X=` means unset. */
function envValue(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v ? v : undefined;
}

/**
 * A number from the first source that holds a usable one: the environment variable
 * (parsed), then the setting (which must already be a number — a JSON string is not
 * accepted), then the default. Non-finite values are skipped, and so are values
 * above `max` (for a fraction, 75 meant 75%: clamping it to 0.99 would let the
 * window fill). A skipped value that was actually set is reported by name.
 */
function numberSetting(
	envName: string,
	settingName: string,
	setting: unknown,
	fallback: number,
	max = Number.POSITIVE_INFINITY,
): number {
	const candidates: Array<[string, unknown]> = [
		[envName, envValue(envName)],
		[`penpi.${settingName}`, setting],
	];
	for (const [source, raw] of candidates) {
		if (raw === undefined || raw === null) continue;
		const n =
			typeof raw === "number" ? raw : typeof raw === "string" && source === envName ? Number(raw) : Number.NaN;
		if (Number.isFinite(n) && n <= max) return n;
		console.error(
			`[PENpi] ignoring ${source}=${JSON.stringify(raw)}: ${Number.isFinite(n) ? `must be at most ${max}` : "not a finite number"}.`,
		);
	}
	return fallback;
}

/** A boolean from the environment variable (`parse`), then the setting (booleans only), then the default. */
function booleanSetting(
	envName: string,
	settingName: string,
	parse: (v: string) => boolean,
	setting: unknown,
	fallback: boolean,
): boolean {
	const env = envValue(envName);
	if (env !== undefined) return parse(env);
	if (setting !== undefined && setting !== null && typeof setting !== "boolean") {
		console.error(`[PENpi] ignoring penpi.${settingName}=${JSON.stringify(setting)}: not a boolean.`);
	}
	return typeof setting === "boolean" ? setting : fallback;
}

function clamp01(n: number): number {
	return Math.min(0.99, Math.max(0.01, n));
}

export function resolvePenpiConfig(settings: PenpiSettings = loadPenpiSettings()): PenpiConfig {
	const ceiling = clamp01(numberSetting("PENPI_CONTEXT_CEILING", "contextCeiling", settings.contextCeiling, 0.8, 1));
	let floor = clamp01(numberSetting("PENPI_CONTEXT_FLOOR", "contextFloor", settings.contextFloor, 0.2, 1));
	if (floor >= ceiling) floor = Math.max(ceiling / 2, ceiling - 0.1); // floor must sit below ceiling
	const truthy = (v: string) => v === "true" || v === "1";
	// Default OFF (opt-in): only save a checkpoint on shutdown when explicitly enabled.
	const save = booleanSetting(
		"PENPI_SAVE_CONTEXT_ON_SHUTDOWN",
		"saveContextOnShutdown",
		truthy,
		settings.saveContextOnShutdown,
		false,
	);
	// Default ON. Disabling is an advanced diagnostic control, also exposed as --penpi-raw.
	const injectBriefing = booleanSetting(
		"PENPI_INJECT_BRIEFING",
		"injectBriefing",
		(v) => v !== "false" && v !== "0",
		settings.injectBriefing,
		true,
	);
	// Default OFF (opt-in): show the injected briefing in the UI as well.
	const displayBriefing = booleanSetting(
		"PENPI_DISPLAY_BRIEFING",
		"displayBriefing",
		truthy,
		settings.displayBriefing,
		false,
	);
	// At least one run of grace; a non-integer rounds down.
	const emergencyCompactionRuns = Math.max(
		1,
		Math.floor(
			numberSetting(
				"PENPI_EMERGENCY_COMPACTION_RUNS",
				"emergencyCompactionRuns",
				settings.emergencyCompactionRuns,
				15,
			),
		),
	);
	return {
		contextCeiling: ceiling,
		contextFloor: floor,
		saveContextOnShutdown: save,
		injectBriefing,
		displayBriefing,
		emergencyCompactionRuns,
	};
}

function resolveApiKey(settings: PenpiSettings): string | undefined {
	const inline = process.env.PENPI_PENFIELD_API_KEY?.trim() || settings.penfield?.apiKey?.trim();
	if (inline) return inline;
	const file = process.env.PENPI_PENFIELD_API_KEY_FILE?.trim() || settings.penfield?.apiKeyFile?.trim();
	if (file) {
		try {
			return readFileSync(expandHome(file), "utf8").trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Resolve Penfield configuration. Production is the default.
 */
export function resolvePenfieldConfig(
	settings: PenpiSettings = loadPenpiSettings(),
	envOverride?: string,
): PenfieldConfig {
	const envRaw = envOverride?.trim() || process.env.PENPI_PENFIELD_ENV?.trim() || settings.penfield?.env?.trim();
	const env: PenfieldEnv = envRaw === "dev" ? "dev" : "prod";
	const apiKey = resolveApiKey(settings);
	const tokenStorePath = expandHome(
		process.env.PENPI_PENFIELD_TOKEN_STORE?.trim() ||
			settings.penfield?.tokenStore?.trim() ||
			join(homedir(), ".config", "penpi", `penfield-tokens-${env}.json`),
	);
	return {
		env,
		mcpUrl: `${hostFor(env, "mcp")}/`,
		apiBase: hostFor(env, "api"),
		authBase: hostFor(env, "auth"),
		authMode: apiKey ? "apiKey" : "deviceCode",
		apiKey,
		clientId: process.env.PENPI_PENFIELD_CLIENT_ID?.trim() || settings.penfield?.clientId?.trim() || undefined,
		tokenStorePath,
		scope: "read write offline_access",
	};
}

/** Adapter connection lifecycle: env overrides settings.penpi.mcpLifecycle. */
export function resolveMcpLifecycle(
	settings: PenpiSettings = loadPenpiSettings(),
): "lazy" | "eager" | "keep-alive" | undefined {
	const v = process.env.PENPI_MCP_LIFECYCLE?.trim() || settings.mcpLifecycle?.trim();
	return v === "lazy" || v === "eager" || v === "keep-alive" ? v : undefined;
}
