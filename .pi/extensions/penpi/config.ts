/**
 * PENpi configuration.
 *
 * Precedence (low → high): built-in defaults → pi settings.json `penpi` key
 * (global agent dir, then project .pi/) → environment variables.
 *
 * Production is the default; an internal selector supports development.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

interface PenpiSettings {
	penfield?: { env?: string; apiKey?: string; apiKeyFile?: string; clientId?: string; tokenStore?: string };
	contextCeiling?: number;
	contextFloor?: number;
	saveContextOnShutdown?: boolean;
	injectBriefing?: boolean;
	displayBriefing?: boolean;
	mcpLifecycle?: string;
}

/** Security-sensitive Penfield settings are global-only. */
const PROJECT_FORBIDDEN_PENFIELD_KEYS = ["apiKey", "apiKeyFile", "clientId", "tokenStore"] as const;

function stripProjectSecrets(project: PenpiSettings): PenpiSettings {
	if (!project.penfield) return project;
	const penfield = { ...project.penfield };
	let stripped = false;
	for (const k of PROJECT_FORBIDDEN_PENFIELD_KEYS) {
		if (penfield[k] !== undefined) {
			delete penfield[k];
			stripped = true;
		}
	}
	if (stripped) {
		console.error(
			`[PENpi] ignoring credential/path settings from the project .pi/settings.json ` +
				`(${PROJECT_FORBIDDEN_PENFIELD_KEYS.join(", ")} are global-only) — a repo cannot redirect PENpi auth.`,
		);
	}
	return { ...project, penfield };
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
 * Merge `penpi` from global agent settings then project .pi/settings.json (project wins),
 * with credentials/paths stripped from the project layer — see PROJECT_FORBIDDEN_PENFIELD_KEYS.
 */
function loadPenpiSettings(): PenpiSettings {
	const global = (readJson(join(piAgentDir(), "settings.json"))?.penpi as PenpiSettings | undefined) ?? {};
	const project = readJson(join(process.cwd(), ".pi", "settings.json"))?.penpi as PenpiSettings | undefined;
	if (!project) return global;
	const safe = stripProjectSecrets(project);
	return { ...global, ...safe, penfield: { ...global.penfield, ...safe.penfield } };
}

function num(env: string | undefined, fallback: number): number {
	const n = env === undefined ? Number.NaN : Number(env);
	return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
	return Math.min(0.99, Math.max(0.01, n));
}

export function resolvePenpiConfig(settings: PenpiSettings = loadPenpiSettings()): PenpiConfig {
	const ceiling = clamp01(num(process.env.PENPI_CONTEXT_CEILING, settings.contextCeiling ?? 0.75));
	let floor = clamp01(num(process.env.PENPI_CONTEXT_FLOOR, settings.contextFloor ?? 0.5));
	if (floor >= ceiling) floor = Math.max(ceiling / 2, ceiling - 0.1); // floor must sit below ceiling
	const saveEnv = process.env.PENPI_SAVE_CONTEXT_ON_SHUTDOWN;
	// Default OFF (opt-in): only save a checkpoint on shutdown when explicitly enabled.
	const save =
		saveEnv !== undefined ? saveEnv === "true" || saveEnv === "1" : (settings.saveContextOnShutdown ?? false);
	// Default ON. Disabling is an advanced diagnostic control, also exposed as --penpi-raw.
	const injectEnv = process.env.PENPI_INJECT_BRIEFING;
	const injectBriefing =
		injectEnv !== undefined ? injectEnv !== "false" && injectEnv !== "0" : (settings.injectBriefing ?? true);
	// Default OFF (opt-in): show the injected briefing in the UI as well.
	const displayEnv = process.env.PENPI_DISPLAY_BRIEFING;
	const displayBriefing =
		displayEnv !== undefined ? displayEnv === "true" || displayEnv === "1" : (settings.displayBriefing ?? false);
	return {
		contextCeiling: ceiling,
		contextFloor: floor,
		saveContextOnShutdown: save,
		injectBriefing,
		displayBriefing,
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
