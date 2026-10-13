/**
 * Penfield credential handling: the token file and the OAuth / API-key requests.
 *
 * - Token writes are atomic (temp file + rename) at mode 0600 and refuse a symlinked path,
 *   so a planted link cannot redirect refresh tokens into another file.
 * - Every OAuth and API-key request uses `redirect: "error"`, so a redirect cannot carry a
 *   device code, refresh token or API key to another URL.
 * - Discovered endpoints must be on one of the exact origins PENpi is configured for.
 */
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PenfieldConfig } from "./config.ts";
import { assertTrustedEndpoint, penfieldOrigins, TokenManager } from "./penfield-client.ts";

const cfg: PenfieldConfig = {
	env: "dev",
	mcpUrl: "https://mcp-dev.penfield.app/",
	apiBase: "https://api-dev.penfield.app",
	authBase: "https://auth-dev.penfield.app",
	authMode: "deviceCode",
	tokenStorePath: "",
	scope: "read write offline_access",
};

const json = (obj: unknown) => ({
	ok: true,
	status: 200,
	json: async () => obj,
	text: async () => JSON.stringify(obj),
});

/** A Penfield fake: discovery on the auth host, refresh at its token endpoint. Records every request. */
function stubPenfield(endpoints: { token_endpoint: string; device_authorization_endpoint: string }) {
	const requests: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown, init: RequestInit = {}) => {
			const u = String(url);
			requests.push({ url: u, redirect: init.redirect });
			if (u.includes("oauth-protected-resource")) return json({ authorization_servers: [cfg.authBase] });
			if (u.includes("oauth-authorization-server")) return json(endpoints);
			if (u.endsWith("/token"))
				return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
			if (u.endsWith("/api/v2/auth/token")) return json({ data: { access_token: "jwt", expires_in: 3600 } });
			return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
		}),
	);
	return requests;
}

const trustedEndpoints = {
	device_authorization_endpoint: "https://auth-dev.penfield.app/device",
	token_endpoint: "https://auth-dev.penfield.app/token",
};

describe("Penfield credentials", () => {
	let dir: string;
	let store: string;

	beforeEach(() => {
		vi.unstubAllGlobals();
		dir = mkdtempSync(join(tmpdir(), "penpi-credentials-"));
		store = join(dir, "penfield-tokens.json");
		writeFileSync(
			store,
			JSON.stringify({ accessToken: "old", expiresAt: 0, refreshToken: "stored-refresh", clientId: "cid" }),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the refreshed token file atomically at mode 0600", async () => {
		stubPenfield(trustedEndpoints);
		const tm = new TokenManager({ ...cfg, tokenStorePath: store });

		expect(await tm.getAccessToken()).toBe("new-access");

		expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({
			accessToken: "new-access",
			refreshToken: "new-refresh",
		});
		expect(statSync(store).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["penfield-tokens.json"]);
	});

	it("refuses to write the token file through a symbolic link", async () => {
		stubPenfield(trustedEndpoints);
		const victim = join(dir, "victim.json");
		writeFileSync(victim, "untouched");
		rmSync(store);
		symlinkSync(victim, store);
		const tm = new TokenManager({ ...cfg, tokenStorePath: store });
		// Seed the refresh token without reading through the link.
		(tm as unknown as { mem: unknown }).mem = {
			accessToken: "old",
			expiresAt: 0,
			refreshToken: "r",
			clientId: "cid",
		};

		// The token still works for this session; it just is not persisted through the link.
		expect(await tm.getAccessToken()).toBe("new-access");
		expect(readFileSync(victim, "utf8")).toBe("untouched");
		expect(lstatSync(store).isSymbolicLink()).toBe(true);
	});

	it('sends every OAuth request with redirect: "error"', async () => {
		const requests = stubPenfield(trustedEndpoints);
		const tm = new TokenManager({ ...cfg, tokenStorePath: store });

		await tm.getAccessToken();

		expect(requests.map((r) => r.url)).toEqual([
			"https://mcp-dev.penfield.app/.well-known/oauth-protected-resource",
			"https://auth-dev.penfield.app/.well-known/oauth-authorization-server",
			"https://auth-dev.penfield.app/token",
		]);
		expect(requests.every((r) => r.redirect === "error")).toBe(true);
	});

	it('sends the API-key exchange with redirect: "error"', async () => {
		const requests = stubPenfield(trustedEndpoints);
		const tm = new TokenManager({ ...cfg, authMode: "apiKey", apiKey: "tm_pf_test", tokenStorePath: store });

		await tm.getAccessToken();

		expect(requests).toEqual([{ url: "https://api-dev.penfield.app/api/v2/auth/token", redirect: "error" }]);
	});

	it("refuses a discovered endpoint on a Penfield host PENpi is not configured for", async () => {
		const requests = stubPenfield({ ...trustedEndpoints, token_endpoint: "https://other.penfield.app/token" });
		const tm = new TokenManager({ ...cfg, tokenStorePath: store });

		await expect(tm.getAccessToken()).rejects.toThrow(/device login required/);
		expect(requests.some((r) => r.url.startsWith("https://other.penfield.app"))).toBe(false);
	});
});

describe("assertTrustedEndpoint (exact origin allowlist)", () => {
	const allowed = penfieldOrigins(cfg);

	it("is built from the configured auth, API and MCP origins", () => {
		expect([...allowed].sort()).toEqual([
			"https://api-dev.penfield.app",
			"https://auth-dev.penfield.app",
			"https://mcp-dev.penfield.app",
		]);
	});

	it("accepts only exact configured origins", () => {
		expect(() =>
			assertTrustedEndpoint("https://auth-dev.penfield.app/token", "token_endpoint", allowed),
		).not.toThrow();
		expect(() =>
			assertTrustedEndpoint("https://api-dev.penfield.app/api/v2/oauth/token", "token_endpoint", allowed),
		).not.toThrow();
		for (const url of [
			"https://auth.penfield.app/token", // another Penfield environment
			"https://evil.penfield.app/token", // any other subdomain
			"https://auth-dev.penfield.app:8443/token", // another port is another origin
			"http://auth-dev.penfield.app/token", // not https
			"https://penfield.app.evil.com/token",
		]) {
			expect(() => assertTrustedEndpoint(url, "token_endpoint", allowed), url).toThrow();
		}
	});
});
