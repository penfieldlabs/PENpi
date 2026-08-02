/**
 * Conscious-layer wiring (Block 7).
 *
 * PENpi owns all Penfield auth, so it also configures pi-mcp-adapter to reach
 * Penfield using the SAME token — no second auth. We hand the JWT to the adapter
 * through an env var and write a single `penfield` server entry into the
 * adapter's mcp.json (`auth: "bearer"`, `bearerTokenEnv`). The adapter is lazy
 * (connects on first tool use), which is after our session_start, so the env
 * var and config are in place by the time it connects.
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
	/** Adapter connection lifecycle. Omit for the adapter default (lazy). */
	lifecycle?: "lazy" | "eager" | "keep-alive";
	/**
	 * Idle seconds before the adapter drops the connection. On reconnect it
	 * re-reads `bearerTokenEnv`, which is how a refreshed JWT reaches the
	 * conscious layer (the adapter resolves the bearer once per connection).
	 */
	idleTimeout?: number;
	/** Override the mcp.json path (defaults to the global Pi agent directory). */
	path?: string;
}

/** Default idle window: recycle the connection often enough to pick up token refreshes. */
const DEFAULT_IDLE_TIMEOUT = 300;

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
		idleTimeout: opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
		...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
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
