/**
 * PENpi thin Penfield client.
 *
 * A small wrapper over the MCP SDK's Streamable-HTTP transport, used by the
 * PENpi hooks (awaken / reflect / save_context). The conscious LLM-facing
 * tools come from pi-mcp-adapter, not from here.
 *
 * Auth: PENpi owns all Penfield auth and shares one token.
 *   - deviceCode (RFC 8628): the shipping path. Register a client (if needed),
 *     run the device ceremony once, persist + refresh tokens locally.
 *   - apiKey: internal exchange for a JWT (no refresh token
 *     is issued, so we just re-exchange when it nears expiry).
 *
 * A custom fetch injects a fresh `Authorization: Bearer <jwt>` on every
 * request, so refresh/re-exchange is transparent to the transport.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PenfieldConfig } from "./config.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Per-request Penfield timeout (override with PENPI_PENFIELD_TIMEOUT_MS). */
function requestTimeoutMs(): number {
	const n = Number(process.env.PENPI_PENFIELD_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Reject if `p` doesn't settle within `ms` — so Penfield latency can never hang the agent. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`Penfield ${label} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

/** fetch with an abort-on-timeout signal. For short request/response calls only — NOT the
 * MCP transport's long-lived SSE stream (that stays on plain fetch; connect/callTool are
 * bounded by withTimeout instead). */
function tfetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	return fetch(input, { ...init, signal: AbortSignal.timeout(requestTimeoutMs()) });
}

export interface DeviceCodePrompt {
	verificationUriComplete: string;
	verificationUri: string;
	userCode: string;
	expiresInSec: number;
}

interface StoredTokens {
	clientId?: string;
	accessToken: string;
	expiresAt: number; // epoch ms
	refreshToken?: string | null;
}

/** Parsed Penfield tool result: JSON object when the tool returns JSON text, else raw text. */
export type ToolResult = { isError: boolean; data: unknown; text: string };

export class TokenManager {
	private readonly cfg: PenfieldConfig;
	private readonly onDeviceCode?: (p: DeviceCodePrompt) => void;
	private mem?: StoredTokens;
	/** Single-flight guard so concurrent callers share one refresh/exchange. */
	private inflight?: Promise<string>;
	/** Cached OAuth endpoints discovered from the authorization-server metadata. */
	private oauthMeta?: { registrationEndpoint?: string; deviceAuthorizationEndpoint: string; tokenEndpoint: string };

	constructor(cfg: PenfieldConfig, onDeviceCode?: (p: DeviceCodePrompt) => void) {
		this.cfg = cfg;
		this.onDeviceCode = onDeviceCode;
	}

	async getAccessToken(): Promise<string> {
		if (this.mem && this.mem.expiresAt - EXPIRY_SKEW_MS > Date.now()) return this.mem.accessToken;
		if (this.inflight) return this.inflight;
		this.inflight = this.acquire().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private acquire(): Promise<string> {
		if (this.cfg.authMode === "apiKey") return this.exchangeApiKey();
		return this.deviceRefresh();
	}

	/**
	 * Interactive device-code ceremony (RFC 8628). Call ONLY from an explicit
	 * login action (e.g. `/penpi login`) — never from startup, since it blocks
	 * while polling for the user to authorize. apiKey mode has no ceremony.
	 */
	async login(): Promise<string> {
		if (this.cfg.authMode === "apiKey") return this.exchangeApiKey();
		const clientId = this.cfg.clientId ?? this.loadStore()?.clientId ?? (await this.registerClient());
		const dev = await this.requestDeviceCode(clientId);
		this.onDeviceCode?.({
			// verification_uri_complete is OPTIONAL per RFC 8628 — fall back to the plain URI.
			verificationUriComplete: dev.verification_uri_complete ?? dev.verification_uri,
			verificationUri: dev.verification_uri,
			userCode: dev.user_code,
			expiresInSec: dev.expires_in,
		});
		return this.pollForToken(clientId, dev);
	}

	/**
	 * True when a token can be obtained WITHOUT an interactive device ceremony
	 * (apiKey mode, or deviceCode mode with a stored valid/refreshable token).
	 * Used to avoid blocking session startup on a first-run device login.
	 */
	hasNonInteractiveAuth(): boolean {
		if (this.cfg.authMode === "apiKey") return Boolean(this.cfg.apiKey);
		const s = this.mem ?? this.loadStore();
		if (!s) return false;
		return Boolean(s.refreshToken) || s.expiresAt - EXPIRY_SKEW_MS > Date.now();
	}

	// --- internal API-key mode ---
	private async exchangeApiKey(): Promise<string> {
		if (!this.cfg.apiKey) throw new Error("PENpi: apiKey auth mode selected but no API key configured");
		const res = await tfetch(`${this.cfg.apiBase}/api/v2/auth/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
		});
		if (!res.ok) throw new Error(`Penfield API-key exchange failed: ${res.status} ${await safeText(res)}`);
		const body = (await res.json()) as { data?: TokenResponse } & TokenResponse;
		const d = body.data ?? body;
		this.mem = {
			accessToken: d.access_token,
			expiresAt: Date.now() + (d.expires_in ?? 86400) * 1000,
			refreshToken: d.refresh_token ?? null,
		};
		return this.mem.accessToken;
	}

	// --- deviceCode mode: non-interactive (cached token or refresh only) ---
	// Never starts a device ceremony — that would block startup. Throws instead,
	// directing the user to run `/penpi login` (handled by login()).
	private async deviceRefresh(): Promise<string> {
		const stored = this.mem ?? this.loadStore();
		if (stored?.accessToken && stored.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
			this.mem = stored;
			return stored.accessToken;
		}
		if (stored?.refreshToken) {
			// Seed mem from the store so a refresh response that omits refresh_token
			// (or clientId) preserves the stored values instead of nulling them.
			this.mem = stored;
			const refreshed = await this.refresh(stored.refreshToken, stored.clientId).catch(() => undefined);
			if (refreshed) return refreshed;
		}
		throw new Error("Penfield device login required — run /penpi login");
	}

	/**
	 * Discover OAuth endpoints — never hardcoded. Full MCP chain:
	 *   1. RFC 9728: the MCP resource's `/.well-known/oauth-protected-resource`
	 *      advertises its `authorization_servers`.
	 *   2. RFC 8414: that authorization server's
	 *      `/.well-known/oauth-authorization-server` advertises the endpoints.
	 * Falls back to the configured auth host only if step 1 is unavailable.
	 */
	private async discoverOAuth(): Promise<{
		registrationEndpoint?: string;
		deviceAuthorizationEndpoint: string;
		tokenEndpoint: string;
	}> {
		if (this.oauthMeta) return this.oauthMeta;
		const asMetadataUrl =
			(await this.discoverAuthServerMetadataUrl()) ?? `${this.cfg.authBase}/.well-known/oauth-authorization-server`;
		// Discovery is only as trustworthy as the endpoints it yields: we post device
		// codes and REFRESH TOKENS to them. Require https and a host inside the
		// configured Penfield domain, so a compromised/misconfigured resource document
		// cannot redirect credentials to an attacker (RFC 9728 §3.3 / RFC 8414 §3.3).
		this.assertTrustedEndpoint(asMetadataUrl, "authorization-server metadata");
		const res = await tfetch(asMetadataUrl, { headers: { Accept: "application/json" } });
		if (!res.ok) throw new Error(`Penfield OAuth discovery failed: ${res.status} ${asMetadataUrl}`);
		const m = (await res.json()) as {
			registration_endpoint?: string;
			device_authorization_endpoint?: string;
			token_endpoint?: string;
		};
		if (!m.device_authorization_endpoint || !m.token_endpoint) {
			throw new Error("Penfield OAuth metadata missing device_authorization_endpoint or token_endpoint");
		}
		this.assertTrustedEndpoint(m.device_authorization_endpoint, "device_authorization_endpoint");
		this.assertTrustedEndpoint(m.token_endpoint, "token_endpoint");
		if (m.registration_endpoint) this.assertTrustedEndpoint(m.registration_endpoint, "registration_endpoint");
		this.oauthMeta = {
			registrationEndpoint: m.registration_endpoint,
			deviceAuthorizationEndpoint: m.device_authorization_endpoint,
			tokenEndpoint: m.token_endpoint,
		};
		return this.oauthMeta;
	}

	private assertTrustedEndpoint(url: string, label: string): void {
		assertTrustedEndpoint(url, label, this.cfg.authBase);
	}

	/** RFC 9728 — ask the MCP resource which authorization server to use. */
	private async discoverAuthServerMetadataUrl(): Promise<string | undefined> {
		try {
			const origin = new URL(this.cfg.mcpUrl).origin;
			const res = await tfetch(`${origin}/.well-known/oauth-protected-resource`, {
				headers: { Accept: "application/json" },
			});
			if (!res.ok) return undefined;
			const j = (await res.json()) as { authorization_servers?: string[] };
			const as = j.authorization_servers?.[0];
			return as ? `${as.replace(/\/+$/, "")}/.well-known/oauth-authorization-server` : undefined;
		} catch {
			return undefined;
		}
	}

	private async registerClient(): Promise<string> {
		const meta = await this.discoverOAuth();
		if (!meta.registrationEndpoint) {
			throw new Error("Penfield OAuth: server advertises no registration endpoint; set penpi.penfield.clientId");
		}
		const res = await tfetch(meta.registrationEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "penpi",
				// Required by the server even though device flow doesn't redirect.
				redirect_uris: ["http://localhost/callback"],
				grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
				token_endpoint_auth_method: "none",
				scope: this.cfg.scope,
			}),
		});
		if (!res.ok) throw new Error(`Penfield client registration failed: ${res.status} ${await safeText(res)}`);
		const j = (await res.json()) as { client_id: string };
		return j.client_id;
	}

	private async requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
		const meta = await this.discoverOAuth();
		const res = await tfetch(meta.deviceAuthorizationEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: clientId, scope: this.cfg.scope }),
		});
		if (!res.ok) throw new Error(`Penfield device authorization failed: ${res.status} ${await safeText(res)}`);
		return (await res.json()) as DeviceCodeResponse;
	}

	private async pollForToken(clientId: string, dev: DeviceCodeResponse): Promise<string> {
		const meta = await this.discoverOAuth();
		let intervalMs = (dev.interval ?? 5) * 1000;
		const deadline = Date.now() + (dev.expires_in ?? 900) * 1000;
		while (Date.now() < deadline) {
			await sleep(intervalMs);
			const res = await tfetch(meta.tokenEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: dev.device_code,
					client_id: clientId,
				}),
			});
			let j: TokenResponse & { error?: string };
			try {
				j = (await res.json()) as TokenResponse & { error?: string };
			} catch {
				// Non-JSON body (e.g. a proxy error page) — fail with the HTTP status, not a SyntaxError.
				throw new Error(`Penfield device-code polling failed: non-JSON response (${res.status})`);
			}
			if (res.ok && j.access_token) return this.persist(j, clientId);
			if (j.error === "authorization_pending") continue;
			if (j.error === "slow_down") {
				intervalMs += 5000;
				continue;
			}
			throw new Error(`Penfield device-code polling failed: ${j.error ?? res.status}`);
		}
		throw new Error("Penfield device-code flow timed out");
	}

	private async refresh(refreshToken: string, clientId?: string): Promise<string> {
		const meta = await this.discoverOAuth();
		const res = await tfetch(meta.tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				...(clientId ? { client_id: clientId } : {}),
			}),
		});
		if (!res.ok) throw new Error(`Penfield token refresh failed: ${res.status}`);
		return this.persist((await res.json()) as TokenResponse, clientId);
	}

	private persist(t: TokenResponse, clientId?: string): string {
		// A refresh response may omit refresh_token (and clientId) when unchanged —
		// don't clobber the stored values to null, or the next refresh breaks.
		const prev = this.mem;
		this.mem = {
			clientId: clientId ?? prev?.clientId,
			accessToken: t.access_token,
			expiresAt: Date.now() + (t.expires_in ?? 259200) * 1000,
			refreshToken: t.refresh_token ?? prev?.refreshToken ?? null,
		};
		try {
			// 0o700: the token directory should not be world-readable either.
			mkdirSync(dirname(this.cfg.tokenStorePath), { recursive: true, mode: 0o700 });
			// mode 0o600 on create closes the window where a new token file would briefly
			// sit at default perms; chmod covers the case where the file already existed.
			writeFileSync(this.cfg.tokenStorePath, JSON.stringify(this.mem), { encoding: "utf8", mode: 0o600 });
			chmodSync(this.cfg.tokenStorePath, 0o600);
		} catch {
			// Non-fatal: tokens stay in memory for this session.
		}
		return this.mem.accessToken;
	}

	private loadStore(): StoredTokens | undefined {
		try {
			return JSON.parse(readFileSync(this.cfg.tokenStorePath, "utf8")) as StoredTokens;
		} catch {
			return undefined;
		}
	}
}

export interface PenfieldClientOptions {
	onDeviceCode?: (p: DeviceCodePrompt) => void;
}

export class PenfieldClient {
	private readonly cfg: PenfieldConfig;
	private client?: Client;
	private readonly tokens: TokenManager;

	constructor(cfg: PenfieldConfig, opts: PenfieldClientOptions = {}) {
		this.cfg = cfg;
		this.tokens = new TokenManager(cfg, opts.onDeviceCode);
	}

	async connect(): Promise<void> {
		if (this.client) await this.disconnect(); // reconnect cleanly, never leak the old transport
		const tokens = this.tokens;
		// Typed as `typeof fetch` (no unsafe cast). Carry over headers whether the SDK
		// passes (url, init) or a Request object, so none are dropped on SDK upgrades.
		const authFetch: typeof fetch = async (input, init) => {
			const token = await tokens.getAccessToken();
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			return fetch(input, { ...init, headers });
		};
		const transport = new StreamableHTTPClientTransport(new URL(this.cfg.mcpUrl), {
			fetch: authFetch,
		});
		const nextClient = new Client({ name: "penpi", version: "0.1.0" }, { capabilities: {} });
		try {
			await withTimeout(nextClient.connect(transport), requestTimeoutMs(), "connect");
			this.client = nextClient;
		} catch (err) {
			await nextClient.close().catch(() => {});
			this.client = undefined;
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		await this.client?.close().catch(() => {});
		this.client = undefined;
	}

	get connected(): boolean {
		return this.client !== undefined;
	}

	hasNonInteractiveAuth(): boolean {
		return this.tokens.hasNonInteractiveAuth();
	}

	/** Current Penfield access token (JWT). Shared with the conscious layer (pi-mcp-adapter). */
	getAccessToken(): Promise<string> {
		return this.tokens.getAccessToken();
	}

	/** Run the interactive device-code login ceremony (for `/penpi login`). */
	login(): Promise<string> {
		return this.tokens.login();
	}

	async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
		if (!this.client) throw new Error("PenfieldClient: not connected");
		let res: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
		try {
			res = (await withTimeout(
				this.client.callTool({ name, arguments: args }),
				requestTimeoutMs(),
				`tool ${name}`,
			)) as typeof res;
		} catch (err) {
			// A transport/auth failure means this connection is no longer trustworthy.
			// Clear it so `/penpi` never reports a stale connected=true state.
			await this.disconnect();
			throw err;
		}
		const text = (res.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n");
		let data: unknown = text;
		try {
			data = JSON.parse(text);
		} catch {
			/* keep raw text */
		}
		return { isError: Boolean(res.isError), data, text };
	}

	// --- Hook-facing helpers (match Penfield's real tool schemas) ---
	awaken(): Promise<ToolResult> {
		return this.callTool("awaken", {});
	}

	reflect(timeWindow = "recent"): Promise<ToolResult> {
		return this.callTool("reflect", { time_window: timeWindow });
	}

	/** save_context takes `name` (required) + optional `description` — NOT memoryIds. */
	saveContext(name: string, description?: string): Promise<ToolResult> {
		return this.callTool("save_context", { name, ...(description ? { description } : {}) });
	}
}

interface TokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
	refresh_token?: string | null;
	scope?: string;
}

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval?: number;
}

/**
 * Reject any discovered URL that isn't https on the configured Penfield domain
 * (or a subdomain of it). Credentials — device codes, refresh tokens — only ever
 * leave this process toward hosts that pass this check, so a compromised or
 * misconfigured discovery document cannot redirect them off-domain.
 *
 * Exported for testing: the happy path is covered by the discovery/refresh tests,
 * this is the guard that must fail closed.
 */
export function assertTrustedEndpoint(url: string, label: string, authBase: string): void {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`Penfield OAuth: ${label} is not a valid URL (${url})`);
	}
	if (u.protocol !== "https:") {
		throw new Error(`Penfield OAuth: refusing non-https ${label} (${u.protocol}//${u.host})`);
	}
	const expected = new URL(authBase).hostname;
	const base = registrableSuffix(expected);
	if (u.hostname !== expected && !u.hostname.endsWith(`.${base}`) && u.hostname !== base) {
		throw new Error(`Penfield OAuth: refusing ${label} on untrusted host ${u.hostname} (expected ${base})`);
	}
}

/**
 * Registrable suffix of a hostname, e.g. `auth.penfield.app` → `penfield.app`.
 * Deliberately simple: the configured host is ours, so the last two labels are the
 * right trust anchor (this is a same-domain check, not a public-suffix parser).
 */
function registrableSuffix(hostname: string): string {
	const parts = hostname.split(".");
	return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 300);
	} catch {
		return "<no body>";
	}
}
