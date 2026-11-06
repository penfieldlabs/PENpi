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
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRefreshLock, refreshLockStaleMs, refreshLockWaitMs, TokenManager } from "./penfield-client.ts";

const CHILD = join(import.meta.dirname, "__fixtures__", "refresh-child.ts");
const SKEW_MS = 60_000; // penfield-client.ts EXPIRY_SKEW_MS

interface Rotating {
	port: number;
	/** Each refresh token the token endpoint was given, in order of arrival. */
	refreshes: string[];
	/** Each token the revocation endpoint was given, with its hint (0.6.1). */
	revoked: Array<{ token: string; hint: string }>;
	close: () => Promise<void>;
}

/** A Penfield token endpoint that rotates: each refresh issues RT<n+1> and AT<n>, and RT<n> is refused afterwards. */
/**
 * `revoke`: the revocation endpoint (0.6.1) answers 200 and ends the refresh token ("ok"), answers 503 ("down"),
 * answers after 10 s ("slow"), or is not in the metadata ("none"). "untrusted": the metadata names a revocation host
 * PENpi does not trust (revoke.penfield.app); "at-down": the access token's revocation answers 503, the refresh token's
 * succeeds (0.6.1 review, R1 and R2).
 */
type RevokeMode = "ok" | "down" | "slow" | "none" | "untrusted" | "at-down";

async function startRotating(delayMs = 300, revoke: RevokeMode = "ok"): Promise<Rotating> {
	let current = 1;
	const refreshes: string[] = [];
	const revoked: Array<{ token: string; hint: string }> = [];
	const dead = new Set<string>();
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
				...(revoke === "none"
					? {}
					: {
							revocation_endpoint:
								revoke === "untrusted"
									? "https://revoke.penfield.app/revoke"
									: "https://auth-dev.penfield.app/revoke",
						}),
			});
		if (path === "/revoke" && req.method === "POST") {
			const form = new URLSearchParams(await read(req));
			if (revoke === "down" || (revoke === "at-down" && form.get("token_type_hint") === "access_token"))
				return json(503, { error: "temporarily_unavailable" });
			if (revoke === "slow") await new Promise((r) => setTimeout(r, 10_000));
			revoked.push({ token: form.get("token") ?? "", hint: form.get("token_type_hint") ?? "" });
			if (form.get("token_type_hint") === "refresh_token") dead.add(form.get("token") ?? "");
			return json(200, {});
		}
		if (path === "/token" && req.method === "POST") {
			const rt = new URLSearchParams(await read(req)).get("refresh_token") ?? "";
			refreshes.push(rt);
			// Decide at arrival, as a real server does: the first request with the current token wins.
			const ok = rt === `RT${current}` && !dead.has(rt);
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
		revoked,
		close: () =>
			new Promise<void>((r) => {
				http.closeAllConnections();
				http.close(() => r());
			}),
	};
}

type ChildLine = { token?: string; error?: string; loggedOut?: boolean; revocation?: string };

/**
 * One child process, with the readiness handshake (0.6.1 review): `ready` resolves once it has started, `go()` starts
 * its clock (its AT_TIMES and LOGOUT_AT count from then), and `done` resolves with its JSON lines.
 */
function startChild(env: Record<string, string>): { ready: Promise<void>; go: () => void; done: Promise<ChildLine[]> } {
	const child = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	let err = "";
	let markReady: () => void = () => {};
	const ready = new Promise<void>((r) => {
		markReady = r;
	});
	child.stdout.on("data", (c) => {
		out += c;
		if (out.includes('{"ready":true}')) markReady();
	});
	child.stderr.on("data", (c) => {
		err += c;
	});
	const done = new Promise<ChildLine[]>((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve(
						out
							.trim()
							.split("\n")
							.filter((l) => l && l !== '{"ready":true}')
							.map((l) => {
								const { pid: _pid, ...rest } = JSON.parse(l);
								return rest;
							}),
					)
				: reject(new Error(`child exited ${code}: ${err}`)),
		);
	});
	return { ready, go: () => child.stdin.end("go\n"), done };
}

/** Starts every child, waits until all are ready, runs `seed` (the store as of "go"), then starts them together. */
async function together(envs: Array<Record<string, string>>, seed: () => void = () => {}): Promise<ChildLine[][]> {
	const children = envs.map(startChild);
	await Promise.all(children.map((c) => c.ready));
	seed();
	for (const c of children) c.go();
	return Promise.all(children.map((c) => c.done));
}

/** One child, started at once. */
async function runChild(env: Record<string, string>): Promise<ChildLine[]> {
	return (await together([env]))[0];
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
		const env = { STORE: store, PORT: String(fx.port), AT_TIMES: "0" };
		const results = await together([env, env, env], () =>
			writeFileSync(
				store,
				JSON.stringify({ clientId: "cid", accessToken: "AT0", expiresAt: Date.now() - 1000, refreshToken: "RT1" }),
				{ mode: 0o600 },
			),
		);
		expect(results.map((r) => r[0])).toEqual([{ token: "AT1" }, { token: "AT1" }, { token: "AT1" }]);
		expect(fx.refreshes).toEqual(["RT1"]);
		const saved = JSON.parse(readFileSync(store, "utf8"));
		expect(saved.refreshToken).toBe("RT2");
		expect(existsSync(`${store}.lock`)).toBe(false);
	}, 30_000);

	it("two live sessions across an expiry: the second uses the pair the first stored, with no refresh of its own", async () => {
		// Valid for 4 s more (beyond the 60 s skew) from "go": both sessions read it at once, then both see it expire,
		// the first at 6 s and the second at 8.5 s, after the first has stored the new pair.
		const env = { STORE: store, PORT: String(fx.port) };
		const [a, b] = await together(
			[
				{ ...env, AT_TIMES: "0,6000" },
				{ ...env, AT_TIMES: "0,8500" },
			],
			() =>
				writeFileSync(
					store,
					JSON.stringify({
						clientId: "cid",
						accessToken: "AT0",
						expiresAt: Date.now() + SKEW_MS + 4000,
						refreshToken: "RT1",
					}),
					{ mode: 0o600 },
				),
		);
		expect(a).toEqual([{ token: "AT0" }, { token: "AT1" }]);
		expect(b).toEqual([{ token: "AT0" }, { token: "AT1" }]);
		expect(fx.refreshes).toEqual(["RT1"]);
	}, 30_000);
});

describe("a logout sticks against another running session (0.6.1 review)", () => {
	let dir: string;
	let store: string;
	let fx: Rotating;
	beforeEach(async (context) => {
		dir = mkdtempSync(join(tmpdir(), "penpi-logout-procs-"));
		store = join(dir, "penfield-tokens-dev.json");
		// A refresh slow enough for a logout to start during it (a process starts in up to about a second).
		fx = await startRotating(context.task.name.includes("during") ? 4_000 : 300);
	});
	afterEach(async () => {
		await fx.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("a session started before the logout does not log back in: not while its token is valid, not after it expires", async () => {
		const env = { STORE: store, PORT: String(fx.port) };
		// B reads the store at once, asks again after the logout (its token still valid), and once more after it expired.
		const [bOut, aOut] = await together(
			[
				{ ...env, AT_TIMES: "0,4500,9000" },
				{ ...env, LOGOUT_AT: "3000" },
			],
			() =>
				writeFileSync(
					store,
					JSON.stringify({
						clientId: "cid",
						accessToken: "AT0",
						expiresAt: Date.now() + SKEW_MS + 6000,
						refreshToken: "RT1",
					}),
					{ mode: 0o600 },
				),
		);
		expect(aOut).toEqual([{ loggedOut: true, revocation: "revoked" }]);
		expect(bOut[0]).toEqual({ token: "AT0" });
		expect(bOut[1]).toEqual({ error: "Penfield device login required — run /penpi login" });
		expect(bOut[2]).toEqual({ error: "Penfield device login required — run /penpi login" });
		expect(fx.refreshes).toEqual([]);
		expect(existsSync(store)).toBe(false);
	}, 30_000);

	it("a logout during another session's refresh: the store stays gone", async () => {
		const env = { STORE: store, PORT: String(fx.port) };
		// Both started and ready; B refreshes at once (the fixture answers after 4 s); A logs out once the fixture has B's
		// request.
		const b = startChild({ ...env, AT_TIMES: "0" });
		const a = startChild({ ...env, LOGOUT_AT: "0" });
		await Promise.all([a.ready, b.ready]);
		writeFileSync(
			store,
			JSON.stringify({ clientId: "cid", accessToken: "AT0", expiresAt: Date.now() - 1000, refreshToken: "RT1" }),
			{ mode: 0o600 },
		);
		b.go();
		while (fx.refreshes.length === 0) await new Promise((r) => setTimeout(r, 20));
		a.go();
		const [, aOut] = await Promise.all([b.done, a.done]);
		expect(fx.refreshes).toEqual(["RT1"]);
		expect(aOut).toEqual([{ loggedOut: true, revocation: "revoked" }]);
		// Wait for anything still writing, then look.
		await new Promise((r) => setTimeout(r, 500));
		expect(existsSync(store)).toBe(false);
		expect(existsSync(`${store}.lock`)).toBe(false);
	}, 30_000);
});

describe("logout revokes the login at Penfield (0.6.1)", () => {
	let dir: string;
	let store: string;
	const fixtures: Rotating[] = [];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "penpi-revoke-procs-"));
		store = join(dir, "penfield-tokens-dev.json");
	});
	afterEach(async () => {
		while (fixtures.length) await fixtures.pop()?.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const fixture = async (revoke: RevokeMode, delayMs = 300) => {
		const fx = await startRotating(delayMs, revoke);
		fixtures.push(fx);
		return fx;
	};
	const seed = (expiresAt: number) =>
		writeFileSync(store, JSON.stringify({ clientId: "cid", accessToken: "AT0", expiresAt, refreshToken: "RT1" }), {
			mode: 0o600,
		});
	/** A refresh straight at the fixture, as another holder of the refresh token would send it. */
	const refreshAt = (fx: Rotating, rt: string) =>
		fetch(`http://127.0.0.1:${fx.port}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: "cid" }),
		}).then((r) => r.status);

	it("revokes the refresh token, then the access token; the old refresh token is refused afterwards", async () => {
		const fx = await fixture("ok");
		seed(Date.now() + SKEW_MS + 60_000);
		const out = await runChild({ STORE: store, PORT: String(fx.port), LOGOUT_AT: "0" });
		expect(out).toEqual([{ loggedOut: true, revocation: "revoked" }]);
		expect(fx.revoked).toEqual([
			{ token: "RT1", hint: "refresh_token" },
			{ token: "AT0", hint: "access_token" },
		]);
		expect(existsSync(store)).toBe(false);
		expect(await refreshAt(fx, "RT1")).toBe(401);
	}, 30_000);

	it("another session started before the logout gets login required at its next refresh, not a silent re-login", async () => {
		const fx = await fixture("ok");
		const env = { STORE: store, PORT: String(fx.port) };
		const [bOut, aOut] = await together(
			[
				{ ...env, AT_TIMES: "0,6000" },
				{ ...env, LOGOUT_AT: "2000" },
			],
			() => seed(Date.now() + SKEW_MS + 3000),
		);
		expect(aOut).toEqual([{ loggedOut: true, revocation: "revoked" }]);
		expect(bOut).toEqual([{ token: "AT0" }, { error: "Penfield device login required — run /penpi login" }]);
		expect(fx.refreshes).toEqual([]);
		expect(existsSync(store)).toBe(false);
		// And had B, or anything else, sent the refresh token it holds, Penfield would refuse it.
		expect(await refreshAt(fx, "RT1")).toBe(401);
	}, 30_000);

	it("the revocation endpoint answers 503: the local logout completes, and says Penfield refused", async () => {
		const fx = await fixture("down");
		seed(Date.now() + SKEW_MS + 60_000);
		const out = await runChild({ STORE: store, PORT: String(fx.port), LOGOUT_AT: "0" });
		expect(out).toEqual([{ loggedOut: true, revocation: "refused" }]);
		expect(existsSync(store)).toBe(false);
		expect(existsSync(`${store}.lock`)).toBe(false);
	}, 30_000);

	it("the revocation endpoint is slow: the local logout completes within its time limit", async () => {
		const fx = await fixture("slow");
		seed(Date.now() + SKEW_MS + 60_000);
		const child = startChild({ STORE: store, PORT: String(fx.port), LOGOUT_AT: "0", REVOKE_TIMEOUT_MS: "1500" });
		await child.ready;
		const t0 = Date.now();
		child.go();
		const out = await child.done;
		expect(out).toEqual([{ loggedOut: true, revocation: "unreachable" }]);
		expect(Date.now() - t0).toBeLessThan(6_000); // the endpoint answers after 10 s
		expect(existsSync(store)).toBe(false);
	}, 30_000);

	it("0.6.1 review RV1: an untrusted revocation endpoint does not stop refresh; logout reports it and sends nothing", async () => {
		const fx = await fixture("untrusted");
		const env = { STORE: store, PORT: String(fx.port) };
		seed(Date.now() - 1000);
		expect(await runChild({ ...env, AT_TIMES: "0" })).toEqual([{ token: "AT1" }]);
		expect(fx.refreshes).toEqual(["RT1"]);
		const out = await runChild({ ...env, LOGOUT_AT: "0" });
		expect(out).toEqual([{ loggedOut: true, revocation: "untrusted" }]);
		expect(fx.revoked).toEqual([]);
		expect(existsSync(store)).toBe(false);
	}, 30_000);

	it("0.6.1 review RV2: the refresh token revoked and the access token's revocation refused: reported as revoked", async () => {
		const fx = await fixture("at-down");
		seed(Date.now() + SKEW_MS + 60_000);
		const out = await runChild({ STORE: store, PORT: String(fx.port), LOGOUT_AT: "0" });
		expect(out).toEqual([{ loggedOut: true, revocation: "revoked" }]);
		expect(fx.revoked).toEqual([{ token: "RT1", hint: "refresh_token" }]); // the 503 is not recorded as revoked
		expect(await refreshAt(fx, "RT1")).toBe(401);
	}, 30_000);

	it("0.6.1 review F1: no lock to be had, a refresh in flight elsewhere, then a logout: the refresh does not bring the store back", async () => {
		// A directory at the lock path: neither process gets the lock, so only persist()'s logged-out guard stands
		// between the refresh's result and the deleted store.
		mkdirSync(`${store}.lock`);
		const fx = await fixture("ok", 3_000);
		const env = { STORE: store, PORT: String(fx.port) };
		const b = startChild({ ...env, AT_TIMES: "0" });
		const a = startChild({ ...env, LOGOUT_AT: "0" });
		await Promise.all([a.ready, b.ready]);
		seed(Date.now() - 1000);
		b.go();
		while (fx.refreshes.length === 0) await new Promise((r) => setTimeout(r, 20));
		a.go();
		const aOut = await a.done; // done before B's refresh answers: the fixture holds it 3 s
		expect(aOut).toEqual([{ loggedOut: true, revocation: "revoked" }]);
		expect(existsSync(store)).toBe(false);
		const bOut = await b.done;
		expect(bOut).toEqual([{ error: "Penfield device login required — run /penpi login" }]);
		expect(existsSync(store)).toBe(false);
	}, 30_000);

	it("no revocation endpoint in the metadata: logged out here only", async () => {
		const fx = await fixture("none");
		seed(Date.now() + SKEW_MS + 60_000);
		const out = await runChild({ STORE: store, PORT: String(fx.port), LOGOUT_AT: "0" });
		expect(out).toEqual([{ loggedOut: true, revocation: "no-endpoint" }]);
		expect(fx.revoked).toEqual([]);
		expect(existsSync(store)).toBe(false);
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

	it("0.6.1 review: a dangling link, a directory or a stale lock in a read-only folder gives up the lock at once", async () => {
		const dangling = join(dir, "a.json");
		symlinkSync(join(dir, "nowhere"), `${dangling}.lock`);
		const asDir = join(dir, "b.json");
		mkdirSync(`${asDir}.lock`);
		const old = (Date.now() - 120_000) / 1000;
		utimesSync(`${asDir}.lock`, old, old);
		const ro = join(dir, "ro");
		mkdirSync(ro);
		writeFileSync(join(ro, "c.json.lock"), "12345.dead");
		utimesSync(join(ro, "c.json.lock"), old, old);
		chmodSync(ro, 0o500);
		try {
			for (const store of [dangling, asDir, join(ro, "c.json")]) {
				const t0 = Date.now();
				expect(await acquireRefreshLock(store, 60_000, 5_000), store).toBeUndefined();
				expect(Date.now() - t0, store).toBeLessThan(1_000);
			}
			expect(existsSync(`${asDir}.lock`)).toBe(true); // a directory is not removed
		} finally {
			chmodSync(ro, 0o700);
		}
	});

	it("0.6.1 review: while it waits for a held lock, the event loop keeps running, and it gives up at its wait limit", async () => {
		const store = join(dir, "held.json");
		writeFileSync(`${store}.lock`, "999.live", { mode: 0o600 });
		let ticks = 0;
		const timer = setInterval(() => ticks++, 20);
		const t0 = Date.now();
		try {
			expect(await acquireRefreshLock(store, 60_000, 500)).toBeUndefined();
		} finally {
			clearInterval(timer);
		}
		expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(ticks).toBeGreaterThan(5);
	});

	it("0.6.1 review: the stale time and the wait follow the request timeout (four requests under the lock)", async () => {
		const saved = process.env.PENPI_PENFIELD_TIMEOUT_MS;
		try {
			delete process.env.PENPI_PENFIELD_TIMEOUT_MS;
			expect([refreshLockStaleMs(), refreshLockWaitMs()]).toEqual([70_000, 80_000]); // 4 × 15 s + 10 s
			process.env.PENPI_PENFIELD_TIMEOUT_MS = "30000";
			expect([refreshLockStaleMs(), refreshLockWaitMs()]).toEqual([130_000, 140_000]);
			// A short timeout does not cut below a logout's revocation limit (20 s).
			process.env.PENPI_PENFIELD_TIMEOUT_MS = "1000";
			expect(refreshLockStaleMs()).toBe(30_000);
			// With the defaults, a lock just older than the stale time is taken over; one just younger is not.
			const store = join(dir, "derived.json");
			writeFileSync(`${store}.lock`, "1.dead", { mode: 0o600 });
			const older = (Date.now() - 31_000) / 1000;
			utimesSync(`${store}.lock`, older, older);
			const release = await acquireRefreshLock(store, undefined, 500);
			expect(release).toBeTypeOf("function");
			release?.();
			writeFileSync(`${store}.lock`, "2.live", { mode: 0o600 });
			const younger = (Date.now() - 25_000) / 1000;
			utimesSync(`${store}.lock`, younger, younger);
			expect(await acquireRefreshLock(store, undefined, 300)).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.PENPI_PENFIELD_TIMEOUT_MS;
			else process.env.PENPI_PENFIELD_TIMEOUT_MS = saved;
		}
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
