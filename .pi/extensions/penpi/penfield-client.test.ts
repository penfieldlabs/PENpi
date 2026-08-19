import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PenfieldConfig } from "./config.ts";
import { assertTrustedEndpoint, PENPI_VERSION, PenfieldClient, TokenManager, withTimeout } from "./penfield-client.ts";

// Mock the MCP SDK so connect()/callTool() can be tested without a live server.
const sdkState = vi.hoisted(() => ({
	connectError: undefined as Error | undefined,
	callError: undefined as Error | undefined,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		async connect() {
			if (sdkState.connectError) throw sdkState.connectError;
		}
		async callTool() {
			if (sdkState.callError) throw sdkState.callError;
			return { content: [{ type: "text", text: '{"ok":true,"n":1}' }] };
		}
		async close() {}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {},
}));

const cfg: PenfieldConfig = {
	env: "dev",
	mcpUrl: "https://mcp-dev.penfield.app/",
	apiBase: "https://api-dev.penfield.app",
	authBase: "https://auth-dev.penfield.app",
	authMode: "apiKey",
	apiKey: "tm_pf_test",
	tokenStorePath: "/tmp/penpi-test-tokens.json",
	scope: "read write offline_access",
};

function mockExchange(token = "jwt-1", expiresIn = 3600) {
	const fetchMock = vi.fn(async () => ({
		ok: true,
		json: async () => ({ data: { access_token: token, token_type: "Bearer", expires_in: expiresIn } }),
		text: async () => "",
	}));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.unstubAllGlobals();
	sdkState.connectError = undefined;
	sdkState.callError = undefined;
});
afterEach(() => vi.unstubAllGlobals());

describe("withTimeout (fast-fail)", () => {
	it("resolves fast values", async () => {
		await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
	});
	it("rejects when the operation is too slow", async () => {
		await expect(withTimeout(new Promise(() => {}), 20, "slow op")).rejects.toThrow(/slow op timed out/);
	});
});

describe("Penfield request timeout", () => {
	afterEach(() => {
		delete process.env.PENPI_PENFIELD_TIMEOUT_MS;
	});
	it("aborts a hanging request via the timeout signal (never hangs)", async () => {
		process.env.PENPI_PENFIELD_TIMEOUT_MS = "30";
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input: unknown, init: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			),
		);
		await expect(new TokenManager(cfg).getAccessToken()).rejects.toThrow();
	});
});

describe("TokenManager (apiKey mode)", () => {
	it("exchanges the API key for a JWT", async () => {
		mockExchange("jwt-abc");
		const tm = new TokenManager(cfg);
		expect(await tm.getAccessToken()).toBe("jwt-abc");
	});

	it("caches the token (no second exchange)", async () => {
		const fetchMock = mockExchange();
		const tm = new TokenManager(cfg);
		await tm.getAccessToken();
		await tm.getAccessToken();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("single-flights concurrent acquisitions", async () => {
		const fetchMock = mockExchange();
		const tm = new TokenManager(cfg);
		await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("hasNonInteractiveAuth is true when an API key is present", () => {
		expect(new TokenManager(cfg).hasNonInteractiveAuth()).toBe(true);
	});

	it("throws a clear error on a failed exchange", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "bad key" })),
		);
		await expect(new TokenManager(cfg).getAccessToken()).rejects.toThrow(/exchange failed: 401/);
	});
});

describe("TokenManager (deviceCode mode)", () => {
	const dc: PenfieldConfig = {
		...cfg,
		authMode: "deviceCode",
		apiKey: undefined,
		tokenStorePath: "/tmp/penpi-none.json",
	};

	it("hasNonInteractiveAuth is false with no stored token", () => {
		expect(new TokenManager(dc).hasNonInteractiveAuth()).toBe(false);
	});

	it("getAccessToken never starts a ceremony — throws to direct the user to /penpi login", async () => {
		await expect(new TokenManager(dc).getAccessToken()).rejects.toThrow(/device login required/i);
	});
});

describe("token refresh + OAuth discovery", () => {
	const STORE = "/tmp/penpi-refresh-test.json";
	const json = (obj: unknown) => ({
		ok: true,
		status: 200,
		json: async () => obj,
		text: async () => JSON.stringify(obj),
	});
	afterEach(() => {
		try {
			rmSync(STORE);
		} catch {}
	});

	it("discovers endpoints (RFC 9728→8414), refreshes, and preserves the stored refresh token when omitted", async () => {
		writeFileSync(
			STORE,
			JSON.stringify({
				accessToken: "old",
				expiresAt: Date.now() - 1000,
				refreshToken: "stored-refresh",
				clientId: "cid",
			}),
		);
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				const u = String(url);
				seen.push(u);
				if (u.includes("oauth-protected-resource"))
					return json({ authorization_servers: ["https://auth-dev.penfield.app"] });
				if (u.includes("oauth-authorization-server"))
					return json({
						device_authorization_endpoint: "https://auth-dev.penfield.app/device",
						token_endpoint: "https://auth-dev.penfield.app/token",
						registration_endpoint: "https://auth-dev.penfield.app/register",
					});
				if (u.includes("/token")) return json({ access_token: "new-access", expires_in: 3600 }); // NO refresh_token
				return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
			}),
		);

		const tm = new TokenManager({ ...cfg, authMode: "deviceCode", apiKey: undefined, tokenStorePath: STORE });
		const tok = await tm.getAccessToken();

		expect(tok).toBe("new-access");
		expect(seen.some((u) => u.includes("oauth-protected-resource"))).toBe(true);
		expect(seen.some((u) => u.includes("oauth-authorization-server"))).toBe(true);
		// Review finding #1: a refresh response without refresh_token must NOT null the stored one.
		const persisted = JSON.parse(readFileSync(STORE, "utf8"));
		expect(persisted.refreshToken).toBe("stored-refresh");
		expect(persisted.accessToken).toBe("new-access");
	});
});

describe("PenfieldClient connect + callTool (SDK mocked)", () => {
	it("connects, parses a JSON tool result, and disconnects", async () => {
		const c = new PenfieldClient({ ...cfg });
		await c.connect();
		expect(c.connected).toBe(true);
		const r = await c.callTool("recall", { query: "x" });
		expect(r.isError).toBe(false);
		expect(r.data).toEqual({ ok: true, n: 1 });
		await c.disconnect();
		expect(c.connected).toBe(false);
	});

	it("does not report connected after connect fails", async () => {
		sdkState.connectError = new Error("401 unauthorized");
		const c = new PenfieldClient({ ...cfg });
		await expect(c.connect()).rejects.toThrow(/401/);
		expect(c.connected).toBe(false);
	});

	it("clears connected state after an established connection fails", async () => {
		const c = new PenfieldClient({ ...cfg });
		await c.connect();
		sdkState.callError = new Error("transport failed");
		await expect(c.callTool("recall")).rejects.toThrow(/transport failed/);
		expect(c.connected).toBe(false);
	});
});

describe("assertTrustedEndpoint", () => {
	const AUTH = "https://auth.penfield.app";

	it("rejects an endpoint on another host", () => {
		// A compromised discovery document must not be able to redirect refresh tokens.
		expect(() => assertTrustedEndpoint("https://evil.com/token", "token_endpoint", AUTH)).toThrow(/untrusted host/);
	});

	it("rejects non-https and lookalike hosts, accepts the real domain", () => {
		expect(() => assertTrustedEndpoint("http://auth.penfield.app/token", "token_endpoint", AUTH)).toThrow(
			/non-https/,
		);
		expect(() => assertTrustedEndpoint("https://penfield.app.evil.com/token", "token_endpoint", AUTH)).toThrow(
			/untrusted host/,
		);
		expect(() => assertTrustedEndpoint("https://auth-dev.penfield.app/token", "token_endpoint", AUTH)).not.toThrow();
	});
});

describe("PENPI_VERSION", () => {
	it("matches the extension's declared package version", async () => {
		const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
		expect(PENPI_VERSION).toBe(pkg.version);
	});
});
