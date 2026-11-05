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

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PenfieldConfig } from "./config.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The error a TokenManager gives when there is no login to use (none stored, refused, or logged out: 0.6.1). */
export const LOGIN_REQUIRED = "Penfield device login required — run /penpi login";
/** 0.6.1: the device login's code expired before it was approved. */
export const DEVICE_CODE_EXPIRED = "the Penfield login code expired before it was approved — run /penpi login again";

/** Whether anything is at the token store's path (a symbolic link counts; a logout removes it). */
function storeExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * 0.6.1: the refresh lock beside the token store, shared by every PENpi process on the machine. Penfield rotates
 * refresh tokens and refuses a used one (`invalid_grant`), so two processes refreshing with the same token leave one
 * of them logged out. A lock older than REFRESH_LOCK_STALE_MS is taken over (a refresh makes at most three sequential
 * requests of DEFAULT_TIMEOUT_MS), so a crashed process cannot block logins; a waiter gives up waiting after
 * REFRESH_LOCK_WAIT_MS and refreshes without it.
 */
const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_WAIT_MS = 70_000;
const REFRESH_LOCK_POLL_MS = 100;

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

/** OAuth and API-key requests: never follow a redirect, which could carry a device code,
 * refresh token or API key to a URL nobody vetted. */
function credentialFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	return tfetch(input, { ...init, redirect: "error" });
}

/**
 * Write the token file atomically (temp file in the same directory, then rename) at mode
 * 0600. Refuses a symbolic link at `path`: a planted link would otherwise direct refresh
 * tokens into whatever file it points at.
 */
export function writeTokenFile(path: string, contents: string): void {
	// 0o700: the token directory should not be world-readable either.
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		if (lstatSync(path).isSymbolicLink()) {
			throw new Error(`refusing to write Penfield tokens through a symbolic link: ${path}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		// "wx": never reuse an existing file; mode applies from creation, so the token is never readable by others.
		writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Take the cross-process refresh lock (`<token store>.lock`, created exclusively at mode 0600). Returns its release,
 * or undefined when no lock can be had: the caller then refreshes without it, as before 0.6.1. That is the case for an
 * unwritable folder, for REFRESH_LOCK_WAIT_MS spent waiting, for anything at the lock path that is not a regular file
 * (a directory, a symbolic link), and for a stale lock that cannot be removed. A lock whose file is older than
 * REFRESH_LOCK_STALE_MS is removed and taken. Every retry checks the deadline and waits REFRESH_LOCK_POLL_MS first, so
 * the loop ends within the wait and never holds the event loop (0.6.1 review: it could spin forever).
 *
 * Two waiters may both find the same lock stale; the second can then remove the lock the first has just taken, and
 * both refresh. The second is then refused (`invalid_grant`), reads the store again and uses what the first stored, and
 * Penfield does not revoke the login over it (checked for 0.6.1), so this is not guarded further.
 */
export async function acquireRefreshLock(
	storePath: string,
	staleMs = REFRESH_LOCK_STALE_MS,
	waitMs = REFRESH_LOCK_WAIT_MS,
): Promise<(() => void) | undefined> {
	const path = `${storePath}.lock`;
	const id = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const deadline = Date.now() + waitMs;
	try {
		mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
	} catch {
		return undefined;
	}
	for (;;) {
		try {
			// "wx" (O_CREAT | O_EXCL): fails on any existing file, a symbolic link included, and never follows one.
			writeFileSync(path, id, { encoding: "utf8", mode: 0o600, flag: "wx" });
			return () => {
				try {
					if (readFileSync(path, "utf8") === id) rmSync(path, { force: true });
				} catch {
					// already gone (taken over as stale): nothing to release
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}
		let held: Stats | undefined;
		try {
			held = lstatSync(path); // the lock itself, never what a link at its path points to
		} catch (error) {
			// ENOENT: released between our attempts; try again, after the wait below.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		if (held) {
			if (!held.isFile()) return undefined; // a directory or a link at the lock path: not ours to remove
			if (Date.now() - held.mtimeMs > staleMs) {
				try {
					rmSync(path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; // cannot remove it
				}
			}
		}
		if (Date.now() > deadline) return undefined;
		await sleep(REFRESH_LOCK_POLL_MS);
	}
}

/** What revoking a login at Penfield came to (0.6.1, `/penpi logout`). */
export type RevokeOutcome =
	| { kind: "revoked" }
	| { kind: "no-endpoint" }
	| { kind: "failed"; reason: string }
	| { kind: "nothing" };

/** The longest a logout waits for Penfield to revoke the login, discovery included: the local logout always happens. */
export const REVOKE_TIMEOUT_MS = 20_000;

/**
 * `/penpi logout` (0.6.1): take the refresh lock (so a refresh in another process finishes first and one that starts
 * later finds the store gone), revoke the stored refresh token (and access token) at Penfield, then remove the store
 * whatever the revocation came to. A symbolic link at the store's path is removed, not what it points at. In API-key
 * mode there is no stored login to revoke. Returns whether a store was there and what revoking it came to.
 */
export async function logoutStoredLogin(
	cfg: PenfieldConfig,
	timeoutMs = REVOKE_TIMEOUT_MS,
): Promise<{ existed: boolean; revocation: RevokeOutcome }> {
	const path = cfg.tokenStorePath;
	const release = await acquireRefreshLock(path);
	try {
		const existed = storeExists(path);
		let stored: StoredTokens | undefined;
		try {
			stored = JSON.parse(readFileSync(path, "utf8")) as StoredTokens;
		} catch {
			stored = undefined; // no store, or one that does not parse: nothing to revoke
		}
		let revocation: RevokeOutcome = { kind: "nothing" };
		if (cfg.authMode !== "apiKey" && (stored?.refreshToken || stored?.accessToken))
			revocation = await withTimeout(new TokenManager(cfg).revoke(stored), timeoutMs, "Penfield revocation").catch(
				(error): RevokeOutcome => ({ kind: "failed", reason: errorText(error) }),
			);
		rmSync(path, { force: true });
		return { existed, revocation };
	} finally {
		release?.();
	}
}

export interface DeviceCodePrompt {
	verificationUriComplete: string;
	verificationUri: string;
	userCode: string;
	expiresInSec: number;
}

type RefreshError = Error & { oauthError?: string };

/** Penfield's OAuth endpoints from the authorization-server metadata. */
interface OAuthEndpoints {
	registrationEndpoint?: string;
	deviceAuthorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Of two token sets, the one whose access token expires last (the more recent refresh). */
function newest(a: StoredTokens | undefined, b: StoredTokens | undefined): StoredTokens | undefined {
	if (!a) return b;
	if (!b) return a;
	return (b.expiresAt ?? 0) > (a.expiresAt ?? 0) ? b : a;
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
	private oauthMeta?: OAuthEndpoints;
	/**
	 * 0.6.1 review: whether this process has seen the token store, by reading it or writing it. Once it has, a missing
	 * store means a logout (`/penpi logout`, here or in another session): the in-memory pair is dropped, not used to
	 * refresh, and a refresh's result is not written back. A process that never read or wrote it (an unwritable folder:
	 * every write failed) has only its in-memory pair, and keeps using it.
	 */
	private storeSeen = false;

	constructor(cfg: PenfieldConfig, onDeviceCode?: (p: DeviceCodePrompt) => void) {
		this.cfg = cfg;
		this.onDeviceCode = onDeviceCode;
	}

	async getAccessToken(): Promise<string> {
		if (this.mem && this.mem.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
			if (this.loggedOut()) throw new Error(LOGIN_REQUIRED);
			return this.mem.accessToken;
		}
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
		const res = await credentialFetch(`${this.cfg.apiBase}/api/v2/auth/token`, {
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
		// 0.6.1: read the store again first. Another PENpi process may have refreshed since this one last read it, and
		// Penfield refuses a refresh token once it has been used, so this process's own copy may be spent.
		const fresh = this.validStored();
		if (fresh) return fresh;
		if (this.loggedOut()) throw new Error(LOGIN_REQUIRED);
		const release = await acquireRefreshLock(this.cfg.tokenStorePath);
		try {
			const meanwhile = this.validStored(); // another process refreshed while this one waited for the lock
			if (meanwhile) return meanwhile;
			// Under the lock, which /penpi logout also takes: a store removed now was logged out, not to be refreshed.
			if (this.loggedOut()) throw new Error(LOGIN_REQUIRED);
			const stored = newest(this.loadStore(), this.mem);
			if (stored?.refreshToken) {
				// Seed mem from the store so a refresh response that omits refresh_token
				// (or clientId) preserves the stored values instead of nulling them.
				this.mem = stored;
				try {
					return await this.refresh(stored.refreshToken, stored.clientId);
				} catch (error) {
					// A refused refresh token: read the store once more before giving up, in case another process (one
					// that took no lock: an older PENpi, or one that gave up waiting) rotated it.
					const after = this.validStored();
					if (after) return after;
					const latest = this.loadStore();
					if (
						(error as RefreshError).oauthError === "invalid_grant" &&
						latest?.refreshToken &&
						latest.refreshToken !== stored.refreshToken
					) {
						this.mem = latest;
						const retried = await this.refresh(latest.refreshToken, latest.clientId).catch(() => undefined);
						if (retried) return retried;
					}
				}
			}
		} finally {
			release?.();
		}
		throw new Error(LOGIN_REQUIRED);
	}

	/**
	 * 0.6.1, `/penpi logout`: revoke a stored login at Penfield's advertised `revocation_endpoint` (RFC 7009, a public
	 * client: `client_id` in the body): the refresh token first, then the access token. Penfield ends the refresh token;
	 * an access token already handed out keeps working until it expires (checked against Penfield for 0.6.1), but it is
	 * sent too. Never throws: the outcome says what happened.
	 */
	async revoke(stored: {
		refreshToken?: string | null;
		accessToken?: string;
		clientId?: string;
	}): Promise<RevokeOutcome> {
		let meta: OAuthEndpoints;
		try {
			meta = await this.discoverOAuth();
		} catch (error) {
			return { kind: "failed", reason: errorText(error) };
		}
		if (!meta.revocationEndpoint) return { kind: "no-endpoint" };
		const send = async (token: string, hint: "refresh_token" | "access_token") => {
			const res = await credentialFetch(meta.revocationEndpoint as string, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					token,
					token_type_hint: hint,
					...(stored.clientId ? { client_id: stored.clientId } : {}),
				}),
			});
			// RFC 7009 2.2: 200 whether or not the token was valid; an error is 4xx or 5xx with an error code.
			if (!res.ok) {
				let code = "";
				try {
					code = String(((await res.json()) as { error?: unknown }).error ?? "");
				} catch {
					// not JSON
				}
				throw new Error(`HTTP ${res.status}${code ? ` ${code}` : ""}`);
			}
		};
		try {
			if (stored.refreshToken) await send(stored.refreshToken, "refresh_token");
			if (stored.accessToken) await send(stored.accessToken, "access_token");
			return { kind: "revoked" };
		} catch (error) {
			return { kind: "failed", reason: errorText(error) };
		}
	}

	/**
	 * True when this process had seen the token store and it is gone (logged out); the in-memory pair is dropped then.
	 * In API-key mode there is no store to log out of.
	 */
	private loggedOut(): boolean {
		if (this.cfg.authMode === "apiKey" || !this.storeSeen || storeExists(this.cfg.tokenStorePath)) return false;
		this.mem = undefined;
		return true;
	}

	/** The stored access token, when the store holds one still valid (and then also in memory). */
	private validStored(): string | undefined {
		const s = this.loadStore();
		if (s?.accessToken && s.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
			this.mem = s;
			return s.accessToken;
		}
		return undefined;
	}

	/**
	 * Discover OAuth endpoints — never hardcoded. Full MCP chain:
	 *   1. RFC 9728: the MCP resource's `/.well-known/oauth-protected-resource`
	 *      advertises its `authorization_servers`.
	 *   2. RFC 8414: that authorization server's
	 *      `/.well-known/oauth-authorization-server` advertises the endpoints.
	 * Falls back to the configured auth host only if step 1 is unavailable.
	 */
	private async discoverOAuth(): Promise<OAuthEndpoints> {
		if (this.oauthMeta) return this.oauthMeta;
		const asMetadataUrl =
			(await this.discoverAuthServerMetadataUrl()) ?? `${this.cfg.authBase}/.well-known/oauth-authorization-server`;
		// Discovery is only as trustworthy as the endpoints it yields: we post device
		// codes and REFRESH TOKENS to them. Require https on one of PENpi's configured
		// Penfield origins, so a compromised/misconfigured resource document cannot
		// redirect credentials to an attacker (RFC 9728 §3.3 / RFC 8414 §3.3).
		this.assertTrustedEndpoint(asMetadataUrl, "authorization-server metadata");
		const res = await credentialFetch(asMetadataUrl, { headers: { Accept: "application/json" } });
		if (!res.ok) throw new Error(`Penfield OAuth discovery failed: ${res.status} ${asMetadataUrl}`);
		const m = (await res.json()) as {
			registration_endpoint?: string;
			device_authorization_endpoint?: string;
			token_endpoint?: string;
			revocation_endpoint?: string;
		};
		if (!m.device_authorization_endpoint || !m.token_endpoint) {
			throw new Error("Penfield OAuth metadata missing device_authorization_endpoint or token_endpoint");
		}
		this.assertTrustedEndpoint(m.device_authorization_endpoint, "device_authorization_endpoint");
		this.assertTrustedEndpoint(m.token_endpoint, "token_endpoint");
		if (m.registration_endpoint) this.assertTrustedEndpoint(m.registration_endpoint, "registration_endpoint");
		// 0.6.1: /penpi logout sends the refresh token here, so it is held to the same origins.
		if (m.revocation_endpoint) this.assertTrustedEndpoint(m.revocation_endpoint, "revocation_endpoint");
		this.oauthMeta = {
			registrationEndpoint: m.registration_endpoint,
			deviceAuthorizationEndpoint: m.device_authorization_endpoint,
			tokenEndpoint: m.token_endpoint,
			revocationEndpoint: m.revocation_endpoint,
		};
		return this.oauthMeta;
	}

	private assertTrustedEndpoint(url: string, label: string): void {
		assertTrustedEndpoint(url, label, penfieldOrigins(this.cfg));
	}

	/** RFC 9728 — ask the MCP resource which authorization server to use. */
	private async discoverAuthServerMetadataUrl(): Promise<string | undefined> {
		try {
			const origin = new URL(this.cfg.mcpUrl).origin;
			const res = await credentialFetch(`${origin}/.well-known/oauth-protected-resource`, {
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
		const res = await credentialFetch(meta.registrationEndpoint, {
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
		const res = await credentialFetch(meta.deviceAuthorizationEndpoint, {
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
			const res = await credentialFetch(meta.tokenEndpoint, {
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
			if (res.ok && j.access_token) return this.persist(j, clientId, true);
			if (j.error === "authorization_pending") continue;
			if (j.error === "slow_down") {
				intervalMs += 5000;
				continue;
			}
			// 0.6.1: Penfield answers an expired device code with invalid_grant (RFC 8628 names it expired_token).
			if (j.error === "invalid_grant" || j.error === "expired_token") throw new Error(DEVICE_CODE_EXPIRED);
			throw new Error(`Penfield device-code polling failed: ${j.error ?? res.status}`);
		}
		throw new Error(DEVICE_CODE_EXPIRED);
	}

	private async refresh(refreshToken: string, clientId?: string): Promise<string> {
		const meta = await this.discoverOAuth();
		const res = await credentialFetch(meta.tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				...(clientId ? { client_id: clientId } : {}),
			}),
		});
		if (!res.ok) {
			// The OAuth error code only (RFC 6749 5.2), e.g. invalid_grant for a refresh token already used.
			let oauthError: string | undefined;
			try {
				oauthError = ((await res.json()) as { error?: unknown }).error as string | undefined;
			} catch {
				// not JSON
			}
			throw Object.assign(
				new Error(`Penfield token refresh failed: ${res.status}${oauthError ? ` (${oauthError})` : ""}`),
				{ oauthError },
			);
		}
		return this.persist((await res.json()) as TokenResponse, clientId);
	}

	private persist(t: TokenResponse, clientId?: string, login = false): string {
		// 0.6.1 review: a refresh that finished after a logout must not bring the store back; only a login writes a new one.
		if (!login && this.loggedOut()) throw new Error(LOGIN_REQUIRED);
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
			writeTokenFile(this.cfg.tokenStorePath, JSON.stringify(this.mem));
			this.storeSeen = true;
		} catch {
			// Non-fatal: tokens stay in memory for this session.
		}
		return this.mem.accessToken;
	}

	private loadStore(): StoredTokens | undefined {
		try {
			const stored = JSON.parse(readFileSync(this.cfg.tokenStorePath, "utf8")) as StoredTokens;
			this.storeSeen = true;
			return stored;
		} catch {
			return undefined;
		}
	}
}

export interface PenfieldClientOptions {
	onDeviceCode?: (p: DeviceCodePrompt) => void;
}

/**
 * Version PENpi reports to Penfield in the MCP client handshake. Must track the
 * extension's package.json — pinned by a test, because a hardcoded literal here
 * silently misreports the client version to the server as the release moves on.
 */
export const PENPI_VERSION = "0.6.0";

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
		const nextClient = new Client({ name: "penpi", version: PENPI_VERSION }, { capabilities: {} });
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

/** The exact origins Penfield OAuth may use: PENpi's configured auth, API and MCP hosts. */
export function penfieldOrigins(cfg: Pick<PenfieldConfig, "authBase" | "apiBase" | "mcpUrl">): ReadonlySet<string> {
	return new Set([cfg.authBase, cfg.apiBase, cfg.mcpUrl].map((url) => new URL(url).origin));
}

/**
 * Discovered endpoints receive device codes and refresh tokens, so each must be https
 * on one of the exact allowed origins (scheme, host and port). Any other host, including
 * other Penfield subdomains, is refused (RFC 9728 §3.3 / RFC 8414 §3.3). Exported for
 * testing: this is the guard that must fail closed.
 */
export function assertTrustedEndpoint(url: string, label: string, allowedOrigins: ReadonlySet<string>): void {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`Penfield OAuth: ${label} is not a valid URL (${url})`);
	}
	if (u.protocol !== "https:") {
		throw new Error(`Penfield OAuth: refusing non-https ${label} (${u.protocol}//${u.host})`);
	}
	if (!allowedOrigins.has(u.origin)) {
		throw new Error(
			`Penfield OAuth: refusing ${label} on untrusted origin ${u.origin} (allowed: ${[...allowedOrigins].join(", ")})`,
		);
	}
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 300);
	} catch {
		return "<no body>";
	}
}
