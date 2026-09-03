/**
 * Conscious-layer wiring (Block 7).
 *
 * PENpi owns all Penfield auth, so it also configures pi-mcp-adapter to reach
 * Penfield using the SAME token — no second auth. We hand the JWT to the adapter
 * through an env var and write a single `penfield` server entry into the
 * adapter's mcp.json (`auth: "bearer"`, `bearerTokenEnv`).
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
 *   - Clean profile: there is no metadata cache, so adapter 2.12.1 bootstraps
 *     every server during its session_start discovery — again after PENpi's — and
 *     hot-registers what it finds (2.12.0+).
 *
 * Worth knowing, because it is counter-intuitive and rules out the obvious
 * "just serve the warm start from cache" idea: the adapter's cached metadata is
 * ALSO unusable before the JWT is published. computeServerHash() hashes the
 * RESOLVED bearer token, so at load time — with `bearerTokenEnv` pointing at an
 * unset variable — the hash cannot match what was stored and isServerCacheValid()
 * rejects the entry. Nothing about the warm path can be made to work earlier than
 * session_start; the fix is to stop trying to act before it.
 *
 * Explicit overrides remain supported (`penpi.mcpLifecycle`, PENPI_MCP_LIFECYCLE);
 * choosing `eager` re-enters the race above. Both paths are proven end to end in
 * mcp-integration.test.ts against the real adapter and a real MCP server.
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
 * Merge a `penfield` server entry into the adapter's mcp.json (idempotent —
 * only the `penfield` key is touched). Returns the path written.
 */
export function ensurePenfieldMcpEntry(cfg: PenfieldConfig, opts: EnsureMcpOptions = {}): string {
	// Always default to the global agent-dir mcp.json. A working repository must never
	// choose where PENpi reads/writes auth-adjacent configuration merely by being cwd.
	// `||` not `??`: an empty PENPI_MCP_CONFIG_PATH (e.g. `export PENPI_MCP_CONFIG_PATH=`)
	// must fall through to the default, not yield "".
	const path = opts.path || process.env.PENPI_MCP_CONFIG_PATH || join(getAgentDir(), "mcp.json");
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
	doc.mcpServers.penfield = {
		url: cfg.mcpUrl,
		auth: "bearer",
		bearerTokenEnv: JWT_ENV,
		directTools: true,
		idleTimeout: opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
		lifecycle: opts.lifecycle ?? "lazy",
	};
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
