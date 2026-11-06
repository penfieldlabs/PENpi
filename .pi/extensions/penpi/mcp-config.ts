/**
 * Conscious-layer wiring (Block 7).
 *
 * PENpi owns all Penfield auth, so it also configures pi-mcp-adapter to reach
 * Penfield using the SAME token — no second auth. We hand the JWT to the adapter
 * through an env var and define a single `penfield` server entry
 * (`auth: "bearer"`, `bearerTokenEnv`).
 *
 * PENpi runs the adapter itself, embedded, with a config built from the GLOBAL
 * mcp.json only (buildAdapterConfig, ADR 0026). The stock adapter package also
 * reads the project's `.mcp.json` and `.pi/mcp.json`, which lets any repository
 * add or replace MCP servers. The `penfield` entry is still persisted to the
 * global mcp.json (ensurePenfieldMcpEntry) so the file shows what is configured.
 *
 * That entry is written with `lifecycle: "lazy"`. Eager looks like the right
 * choice — connect at startup, be ready before the first model turn — and it is
 * wrong, because it loses a race PENpi cannot win:
 *
 *   The JWT is published by wireConsciousLayer() during PENpi's `session_start`.
 *   On a WARM profile the mcp.json from the previous session is already on disk,
 *   so an eager entry makes the adapter connect during extension LOADING, before
 *   any session_start handler runs and therefore before `PENFIELD_JWT` exists.
 *   The connection gets 401, and the adapter does not retry — it throws
 *   UnauthorizedError. The direct tools are then absent for the whole session.
 *   Ordering inside wireConsciousLayer() cannot fix this: the adapter is already
 *   past that point before PENpi's code runs at all.
 *
 * Lazy is correct on both paths, and needs no retry behaviour from the adapter:
 *
 *   - Warm profile: nothing is contacted at load. The adapter's own session_start
 *     runs after PENpi's, so the JWT and the config are both in place by the time
 *     it does anything, and the direct tools come back. Connections happen on
 *     first use.
 *   - Clean profile: there is no metadata cache, so the adapter bootstraps
 *     every server during its session_start discovery — again after PENpi's — and
 *     hot-registers what it finds (2.12.0 and later).
 *
 * Worth knowing, because it is counter-intuitive and rules out the obvious
 * "just serve the warm start from cache" idea: the adapter's cached metadata is
 * ALSO unusable before the JWT is published. computeServerHash() hashes the
 * RESOLVED bearer token, so at load time — with `bearerTokenEnv` pointing at an
 * unset variable — the hash cannot match what was stored and isServerCacheValid()
 * rejects the entry. Nothing about the warm path can be made to work earlier than
 * session_start; the fix is to stop trying to act before it.
 *
 * Explicit overrides remain supported (`penpi.mcpLifecycle`, PENPI_MCP_LIFECYCLE).
 * Since 0.6.0, for `eager` and `keep-alive` PENpi publishes the JWT before the
 * adapter loads (publishTokenBeforeAdapter in index.ts), from the stored login, and
 * without one makes the entry `lazy` for the session, so the race above cannot
 * occur. All of these paths are proven end to end in mcp-integration.test.ts
 * against the real adapter and a real MCP server.
 *
 * Note this is about the CONSCIOUS layer — the tools the model calls. PENpi's
 * automatic orientation does not go through the adapter at all: it uses its own
 * PenfieldClient, so it works regardless of lifecycle.
 *
 * The mcp.json is generated for the selected environment at runtime and is
 * git-ignored — nothing environment-specific is committed.
 */
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PenfieldConfig } from "./config.ts";

/** Env var the adapter reads the bearer token from (auth: "bearer", bearerTokenEnv). */
export const JWT_ENV = "PENFIELD_JWT";

export interface EnsureMcpOptions {
	/**
	 * Adapter connection lifecycle. PENpi writes `lazy` — the adapter's own
	 * default — because it is the only value that works on BOTH startup paths.
	 * See the module header for why `eager` cannot.
	 */
	lifecycle?: "lazy" | "eager" | "keep-alive";
	/**
	 * Idle MINUTES before the adapter drops the connection. On reconnect it
	 * re-reads `bearerTokenEnv`, which is how a refreshed JWT reaches the
	 * conscious layer (the adapter resolves the bearer once per connection).
	 */
	idleTimeout?: number;
	/** Override the mcp.json path (defaults to the global Pi agent directory). */
	path?: string;
}

/** Default idle window: recycle the connection often enough to pick up token refreshes. */
/**
 * Minutes, NOT seconds — the adapter documents `idleTimeout` as "Minutes before
 * idle disconnect". PENpi previously wrote 300 intending five minutes, which the
 * adapter read as five hours, so an idle session held the connection open all day.
 */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;

interface McpDoc {
	mcpServers?: Record<string, unknown>;
	[k: string]: unknown;
}

/**
 * The global mcp.json path. Always the global agent dir by default: a working
 * repository must never choose where PENpi reads or writes auth-adjacent
 * configuration merely by being cwd. `||` not `??`: an empty PENPI_MCP_CONFIG_PATH
 * (e.g. `export PENPI_MCP_CONFIG_PATH=`) must fall through to the default, not yield "".
 */
export function globalMcpConfigPath(path?: string): string {
	return path || process.env.PENPI_MCP_CONFIG_PATH || join(getAgentDir(), "mcp.json");
}

/**
 * PENpi's defaults for every server in the adapter config (0.6.0, pi-mcp-adapter 7.x); a server's own value in the
 * global mcp.json wins, except on the `penfield` entry, which PENpi owns.
 *
 * - `roots`: 7.x answers an MCP server's roots/list with the session's working directory (`file://<cwd>`) unless the
 *   server sets `roots: false`. No server, Penfield included, learns local paths unless the user turns it on.
 * - `tasks`: the MCP Tasks extension, on by default in 7.x. A task's result arrives after its call returned, as a
 *   message the context engine has not planned for.
 */
export const PENPI_SERVER_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({ roots: false, tasks: false });

/** The `penfield` server entry, shared by the persisted file and the embedded adapter. */
export function penfieldServerEntry(cfg: PenfieldConfig, opts: EnsureMcpOptions = {}): Record<string, unknown> {
	return {
		url: cfg.mcpUrl,
		auth: "bearer",
		bearerTokenEnv: JWT_ENV,
		directTools: true,
		idleTimeout: opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
		lifecycle: opts.lifecycle ?? "lazy",
		...PENPI_SERVER_DEFAULTS,
	};
}

/**
 * A server entry from the global mcp.json with PENpi's server defaults under it; a non-object entry is left as is.
 *
 * 0.6.1: a stdio server (one with a `command`) gets PENpi's Penfield credentials empty in its `env`: the bearer
 * (`PENFIELD_JWT`, which PENpi publishes in `process.env` for the adapter's penfield entry, `bearerTokenEnv`) and the
 * API key (`PENPI_PENFIELD_API_KEY`). pi-mcp-adapter 7.x starts a stdio server with all of `process.env` and then the
 * server's own `env` over it (server-manager.ts resolveEnv), so every stdio server got them; Pi's shell already strips
 * both (utils/shell.ts getShellEnv). A server whose own `env` names one keeps what it names.
 */
export const STDIO_BLANKED_ENV = [JWT_ENV, "PENPI_PENFIELD_API_KEY"] as const;

function withServerDefaults(entry: unknown): unknown {
	if (!isRecord(entry)) return entry;
	const merged: Record<string, unknown> = { ...PENPI_SERVER_DEFAULTS, ...entry };
	if (typeof entry.command === "string") {
		const own = isRecord(entry.env) ? entry.env : {}; // a non-object env (null, a string) gets the blanked set alone
		merged.env = { ...Object.fromEntries(STDIO_BLANKED_ENV.map((name) => [name, ""])), ...own };
	}
	return merged;
}

/** The adapter's in-memory config: what `createMcpAdapter({ config })` receives. */
export interface AdapterConfig {
	mcpServers: Record<string, unknown>;
	settings: Record<string, unknown>;
}

/**
 * PENpi's defaults for the adapter's `settings`; the global mcp.json's own `settings` win key by key.
 *
 * - `allowInstall`, `allowScriptToolSave`: the adapter refuses both actions under a host-supplied config anyway;
 *   off, the `mcp` tool no longer offers the model an action that fails (pi-mcp-adapter 7.x).
 * - `semanticSearch`: a `searchMode: "semantic"` search would call a classifier model through Pi's registry, a paid
 *   call outside the context engine and the bench's cost accounting.
 * - `sampling`: no MCP server may make the host call a model.
 *
 * `elicitation` is left to the adapter: on with a UI (a server's question goes to the user), off without one.
 */
export const PENPI_ADAPTER_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
	allowInstall: false,
	allowScriptToolSave: false,
	semanticSearch: false,
	sampling: false,
});

/**
 * Build the embedded adapter's config from the GLOBAL mcp.json only (Security F1).
 *
 * Run as a stock Pi package, pi-mcp-adapter layers the project's `.mcp.json` and
 * `.pi/mcp.json` over the global file, with the project winning. Any repository
 * could then add MCP servers (including stdio servers, i.e. local commands) or
 * replace existing ones just by being the working directory. PENpi instead runs the
 * adapter itself through `createMcpAdapter({ config })`, which reads no files of
 * its own, and hands it this config.
 *
 * The `penfield` entry is added here in memory rather than read back from disk:
 * the adapter takes this config once, at extension load, which on a clean profile
 * is before session_start has ever written the entry.
 *
 * Never throws: a bad global file must not stop PENpi loading. Problems come back
 * as `warning` and the config falls back to the `penfield` entry alone. `imports`
 * is dropped — it pulls in other hosts' configs, and nothing expands it in this mode.
 */
export function buildAdapterConfig(
	cfg: PenfieldConfig,
	opts: EnsureMcpOptions = {},
): { config: AdapterConfig; path: string; warning?: string } {
	const path = globalMcpConfigPath(opts.path);
	const penfieldOnly = (warning: string) => ({
		config: { mcpServers: { penfield: penfieldServerEntry(cfg, opts) }, settings: { ...PENPI_ADAPTER_SETTINGS } },
		path,
		warning,
	});
	let raw: string;
	try {
		if (lstatSync(path).isSymbolicLink()) return penfieldOnly(`refusing to read symbolic-link MCP config ${path}`);
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			return {
				config: {
					mcpServers: { penfield: penfieldServerEntry(cfg, opts) },
					settings: { ...PENPI_ADAPTER_SETTINGS },
				},
				path,
			};
		}
		return penfieldOnly(`could not read ${path} (${errText(err)})`);
	}
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (err) {
		return penfieldOnly(`could not parse ${path} (${errText(err)})`);
	}
	if (!isRecord(doc)) return penfieldOnly(`${path}: JSON root must be an object`);
	if (doc.mcpServers !== undefined && !isRecord(doc.mcpServers)) {
		return penfieldOnly(`${path}: mcpServers must be an object`);
	}
	const config: AdapterConfig = {
		mcpServers: {
			...Object.fromEntries(
				Object.entries(doc.mcpServers ?? {}).map(([name, entry]) => [name, withServerDefaults(entry)]),
			),
			penfield: penfieldServerEntry(cfg, opts),
		},
		settings: { ...PENPI_ADAPTER_SETTINGS, ...(isRecord(doc.settings) ? doc.settings : {}) },
	};
	if (doc.settings !== undefined && !isRecord(doc.settings)) {
		return { config, path, warning: `${path}: settings must be an object; using PENpi's adapter defaults` };
	}
	return { config, path };
}

/**
 * Merge a `penfield` server entry into the adapter's mcp.json (idempotent —
 * only the `penfield` key is touched). Returns the path written.
 */
export function ensurePenfieldMcpEntry(cfg: PenfieldConfig, opts: EnsureMcpOptions = {}): string {
	const path = globalMcpConfigPath(opts.path);
	let doc: McpDoc = {};
	let existed = false;
	let existingMode = 0o600;
	try {
		const stat = lstatSync(path);
		existed = true;
		if (stat.isSymbolicLink()) {
			throw new Error(`PENpi: refusing to read or replace symbolic-link MCP config: ${path}`);
		}
		existingMode = stat.mode & 0o777;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
	}
	if (existed) {
		try {
			doc = JSON.parse(readFileSync(path, "utf8")) as McpDoc;
		} catch (err) {
			// A parse error (hand-edited comment, trailing comma, or torn read) must never
			// become an empty document and silently drop unrelated MCP servers.
			throw new Error(
				`PENpi: refusing to rewrite ${path} — it exists but could not be parsed (${errText(err)}). ` +
					`Fix or remove the file; the conscious layer stays unwired until then.`,
			);
		}
	}
	if (!isRecord(doc)) {
		throw new Error(`PENpi: refusing to rewrite ${path} — JSON root must be an object.`);
	}
	if (doc.mcpServers !== undefined && !isRecord(doc.mcpServers)) {
		throw new Error(`PENpi: refusing to rewrite ${path} — mcpServers must be an object.`);
	}
	doc.mcpServers ??= {};
	doc.mcpServers.penfield = penfieldServerEntry(cfg, opts);
	mkdirSync(dirname(path), { recursive: true });
	// Write via tmp + rename so a concurrent session never observes a half-written
	// file (truncate-then-write would hand it a parse error mid-update).
	const tmp = `${path}.penpi-${process.pid}-${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: existingMode, flag: "wx" });
		renameSync(tmp, path);
		chmodSync(path, existingMode);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
	return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
