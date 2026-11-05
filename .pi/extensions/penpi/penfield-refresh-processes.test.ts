/**
 * 0.6.1: Penfield token refresh across processes (the second reviewer's finding on 0.6.0).
 *
 * Penfield rotates refresh tokens and refuses a used one with `invalid_grant` (checked against Penfield with a test
 * account for 0.6.1; a refused reuse does not revoke the login). Before 0.6.1 each process refreshed with the refresh
 * token it held in memory: three processes started together with an expired access token all sent the same refresh
 * token, and two were left with "Penfield device login required"; a session that had read the store before another
 * process refreshed sent the spent token and failed although the store held a fresh pair. These tests run real
 * processes (`__fixtures__/refresh-child.ts`) against a fixture that rotates and refuses reuse.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRefreshLock, TokenManager } from "./penfield-client.ts";

const CHILD = join(import.meta.dirname, "__fixtures__", "refresh-child.ts");
const SKEW_MS = 60_000; // penfield-client.ts EXPIRY_SKEW_MS

interface Rotating {
	port: number;
	/** Each refresh token the token endpoint was given, in order of arrival. */
	refreshes: string[];
	close: () => Promise<void>;
}

/** A Penfield token endpoint that rotates: each refresh issues RT<n+1> and AT<n>, and RT<n> is refused afterwards. */
async function startRotating(delayMs = 300): Promise<Rotating> {
	let current = 1;
	const refreshes: string[] = [];
	const read = (req: IncomingMessage) =>
		new Promise<string>((r) => {
			let s = "";
			req.on("data", (c) => {
				s += c;
			});
			req.on("end", () => r(s));
		});
	const http: Server = createServer(async (req, res) => {
		const json = (status: number, body: unknown) =>
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		const path = (req.url ?? "").split("?")[0];
		if (path.startsWith("/.well-known/oauth-protected-resource"))
			return json(200, { authorization_servers: ["https://auth-dev.penfield.app"] });
		if (path.startsWith("/.well-known/oauth-authorization-server"))
			return json(200, {
				device_authorization_endpoint: "https://auth-dev.penfield.app/device",
				token_endpoint: "https://auth-dev.penfield.app/token",
			});
		if (path === "/token" && req.method === "POST") {
			const rt = new URLSearchParams(await read(req)).get("refresh_token") ?? "";
			refreshes.push(rt);
			// Decide at arrival, as a real server does: the first request with the current token wins.
			const ok = rt === `RT${current}`;
			const n = current;
			if (ok) current++;
			await new Promise((r) => setTimeout(r, delayMs));
			return ok
				? json(200, { access_token: `AT${n}`, expires_in: 3600, refresh_token: `RT${n + 1}` })
				: json(401, { error: "invalid_grant" });
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
	return {
		port: (http.address() as AddressInfo).port,
		refreshes,
		close: () =>
			new Promise<void>((r) => {
				http.closeAllConnections();
				http.close(() => r());
			}),
	};
}

/** Runs one child process; resolves with its JSON lines. */
function runChild(env: Record<string, string>): Promise<Array<{ token?: string; error?: string }>> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => {
			out += c;
		});
		child.stderr.on("data", (c) => {
			err += c;
		});
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve(
						out
							.trim()
							.split("\n")
							.filter(Boolean)
							.map((l) => {
								const { pid: _pid, ...rest } = JSON.parse(l);
								return rest;
							}),
					)
				: reject(new Error(`child exited ${code}: ${err}`)),
		);
	});
}

describe("Penfield token refresh across processes (0.6.1)", () => {
	let dir: string;
	let store: string;
	let fx: Rotating;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "penpi-refresh-procs-"));
		store = join(dir, "penfield-tokens-dev.json");
		fx = await startRotating();
	});
	afterEach(async () => {
		await fx.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("three processes started together with an expired token: one refresh, every process gets a token", async () => {
		writeFileSync(
			store,
			JSON.stringify({ clientId: "cid", accessToken: "AT0", expiresAt: Date.now() - 1000, refreshToken: "RT1" }),
			{ mode: 0o600 },
		);
		const env = { STORE: store, PORT: String(fx.port), AT_TIMES: "0" };
		const results = await Promise.all([runChild(env), runChild(env), runChild(env)]);
		expect(results.map((r) => r[0])).toEqual([{ token: "AT1" }, { token: "AT1" }, { token: "AT1" }]);
		expect(fx.refreshes).toEqual(["RT1"]);
		const saved = JSON.parse(readFileSync(store, "utf8"));
		expect(saved.refreshToken).toBe("RT2");
		expect(existsSync(`${store}.lock`)).toBe(false);
	}, 30_000);

	it("two live sessions across an expiry: the second uses the pair the first stored, with no refresh of its own", async () => {
		const start = Date.now();
		// Valid for about 4 s more (beyond the 60 s skew), so both sessions first read it (process start-up included), then
		// both see it expire: the first at 6 s, the second at 8.5 s, after the first has stored the new pair.
		writeFileSync(
			store,
			JSON.stringify({
				clientId: "cid",
				accessToken: "AT0",
				expiresAt: start + SKEW_MS + 4000,
				refreshToken: "RT1",
			}),
			{ mode: 0o600 },
		);
		const first = runChild({ STORE: store, PORT: String(fx.port), AT_TIMES: `0,${start + 6000}` });
		const second = runChild({ STORE: store, PORT: String(fx.port), AT_TIMES: `0,${start + 8500}` });
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual([{ token: "AT0" }, { token: "AT1" }]);
		expect(b).toEqual([{ token: "AT0" }, { token: "AT1" }]);
		expect(fx.refreshes).toEqual(["RT1"]);
	}, 30_000);
});

describe("the refresh lock (0.6.1)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "penpi-refresh-lock-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is a 0600 file beside the store, removed on release", async () => {
		const store = join(dir, "tokens.json");
		const release = await acquireRefreshLock(store);
		expect(release).toBeTypeOf("function");
		expect(statSync(`${store}.lock`).mode & 0o777).toBe(0o600);
		release?.();
		expect(existsSync(`${store}.lock`)).toBe(false);
	});

	it("a lock left by a crashed process is taken over once stale; a live one is waited for", async () => {
		const store = join(dir, "tokens.json");
		writeFileSync(`${store}.lock`, "12345.dead", { mode: 0o600 });
		const old = (Date.now() - 120_000) / 1000;
		utimesSync(`${store}.lock`, old, old);
		const release = await acquireRefreshLock(store, 60_000, 1_000);
		expect(release).toBeTypeOf("function");
		// Now held: a second taker waits, then gives up after its wait (and the caller refreshes without the lock).
		const t0 = Date.now();
		expect(await acquireRefreshLock(store, 60_000, 400)).toBeUndefined();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
		release?.();
		const again = await acquireRefreshLock(store, 60_000, 400);
		expect(again).toBeTypeOf("function");
		again?.();
	});
});

describe("after invalid_grant, the store is read once more (0.6.1)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "penpi-refresh-regrant-"));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	it("a process that took no lock rotated the token mid-refresh: retry once with the stored one", async () => {
		const store = join(dir, "tokens.json");
		writeFileSync(
			store,
			JSON.stringify({ clientId: "cid", accessToken: "AT0", expiresAt: Date.now() - 1000, refreshToken: "RT1" }),
			{ mode: 0o600 },
		);
		const sent: string[] = [];
		const reply = (status: number, body: unknown) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("oauth-protected-resource"))
				return reply(200, { authorization_servers: ["https://auth-dev.penfield.app"] });
			if (u.includes("oauth-authorization-server"))
				return reply(200, {
					device_authorization_endpoint: "https://auth-dev.penfield.app/device",
					token_endpoint: "https://auth-dev.penfield.app/token",
				});
			const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
			sent.push(rt);
			if (rt === "RT1") {
				// another process (an older PENpi, without the lock) used RT1 first and stored its pair, already expired here
				writeFileSync(
					store,
					JSON.stringify({
						clientId: "cid",
						accessToken: "ATx",
						expiresAt: Date.now() - 1000,
						refreshToken: "RT2",
					}),
				);
				return reply(401, { error: "invalid_grant" });
			}
			if (rt === "RT2") return reply(200, { access_token: "AT2", expires_in: 3600, refresh_token: "RT3" });
			return reply(401, { error: "invalid_grant" });
		});
		const tm = new TokenManager({
			env: "dev",
			mcpUrl: "https://mcp-dev.penfield.app/",
			apiBase: "https://api-dev.penfield.app",
			authBase: "https://auth-dev.penfield.app",
			authMode: "deviceCode",
			tokenStorePath: store,
			scope: "read write offline_access",
		});
		expect(await tm.getAccessToken()).toBe("AT2");
		expect(sent).toEqual(["RT1", "RT2"]);
		expect(JSON.parse(readFileSync(store, "utf8")).refreshToken).toBe("RT3");
	});
});
