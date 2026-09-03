import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createExtensionRuntime,
	type ExtensionActions,
	type ExtensionContextActions,
	ExtensionRunner,
	type ModelRegistry,
	type SessionManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Agent, type Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { FIXTURE_BRIEFING, type FixturePenfield, startFixturePenfield } from "./__fixtures__/penfield-server.ts";
import { BRIEFING_CUSTOM_TYPE } from "./config.ts";

/**
 * Cross-package integration: PENpi and the REAL pi-mcp-adapter, loaded together
 * through Pi's REAL extension loader, driven by Pi's REAL ExtensionRunner,
 * against a real MCP server.
 *
 * Two startup paths have to work, and they fail differently:
 *
 *   CLEAN profile (first ever run) — no mcp.json, no metadata cache. Nothing for
 *   the adapter to read at load time, so PENpi's `session_start` writes the entry
 *   and publishes the JWT first, and the adapter's own `session_start` discovery
 *   then bootstraps and hot-registers the direct tools.
 *
 *   WARM profile (every run after the first) — mcp.json and the adapter's
 *   metadata cache are already on disk, and the adapter reads them at LOAD time,
 *   before any session_start handler exists to publish `PENFIELD_JWT`. With a
 *   `lazy` entry nothing is contacted then; the adapter's own session_start runs
 *   after PENpi's, so the token is in place and the tools come back. With an
 *   `eager` entry it connects immediately, takes a 401, does not retry, and the
 *   direct tools are gone for the whole session. That is why PENpi writes
 *   `lazy`; see mcp-config.ts. (The cached metadata cannot rescue the early
 *   window either — its hash covers the resolved bearer, so it fails validation
 *   until the token exists. Asserted below.)
 *
 * Both are tested below, because a test of only the clean path cannot see the
 * warm-path race at all — the file it depends on does not exist yet.
 *
 * Two things are simulated, both at the edges and neither inside PENpi or the
 * adapter:
 *
 *   - The Penfield deployment: a real MCP server on loopback (see
 *     __fixtures__/penfield-server.ts). PENpi writes a URL entry, so the fixture
 *     is reached by redirecting that origin's TCP connection at undici's
 *     dispatcher. The entry, the transport, and both MCP clients are untouched.
 *     The fixture ENFORCES the bearer, so a request carrying the wrong one gets a
 *     401 and reaches no tool — which is what lets tool availability stand as
 *     evidence about auth.
 *   - The Penfield credential: a seeded, unexpired token store, so
 *     getAccessToken() resolves without a network round trip or a device
 *     ceremony. Deliberately stored with NO refresh token — if the cached-token
 *     path ever stopped working, the test fails instead of quietly reaching out
 *     to the real auth server.
 *
 * Pi's loader is what makes the adapter loadable at all. Its static import chain
 * reaches `complete` from the `@earendil-works/pi-ai` root, which that package
 * does not export there — loader.ts aliases the root to the `compat` entrypoint,
 * which does. A hand-rolled host that bypasses the loader fails at module load;
 * that failure is an artifact of the harness, not of the adapter.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const loaderPath = join(repoRoot, "packages", "coding-agent", "dist", "core", "extensions", "loader.js");
const adapterRoot = join(repoRoot, "node_modules", "pi-mcp-adapter");
const adapterEntry = join(adapterRoot, "index.ts");
const penpiEntry = join(here, "index.ts");

/** The URL PENpi writes for the dev environment. The fixture answers on this origin. */
const PENFIELD_DEV_URL = "https://mcp-dev.penfield.app/";
/** Seeded access token. PENpi must publish exactly this to the adapter. */
const SEEDED_TOKEN = "penpi-integration-access-token";

/**
 * These tests drive Pi's COMPILED loader and the installed adapter, so they need
 * a built monorepo — not a deployed copy of the extension. Missing prerequisites
 * are a setup problem with a one-line fix, so they are reported as such rather
 * than as a PENpi regression. See the prerequisite test for the message.
 */
const ready = existsSync(loaderPath) && existsSync(adapterEntry);

/** Provider requests emitted so far, so "before the first one" is machine-checked. */
let providerRequests = 0;

const profiles: string[] = [];

afterAll(() => {
	for (const dir of profiles) rmSync(dir, { recursive: true, force: true });
});

/** A profile directory with nothing in it: no mcp.json, no metadata cache, no state. */
function cleanProfile(): string {
	const dir = mkdtempSync(join(tmpdir(), "penpi-mcp-e2e-"));
	profiles.push(dir);
	return dir;
}

/** Set an env var, returning a restore function that distinguishes unset from empty. */
function setEnv(name: string, value: string | undefined): () => void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return () => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	};
}

/** Point every outbound connection at the fixture, preserving the request verbatim. */
function redirectTo(fixture: FixturePenfield): Dispatcher {
	const previous = getGlobalDispatcher();
	setGlobalDispatcher(
		new Agent({
			connect(_options, callback) {
				const socket = net.connect(fixture.port, "127.0.0.1", () => callback(null, socket));
				socket.on("error", callback);
			},
		}),
	);
	return previous;
}

/** The env a PENpi session needs, pinned so an ambient value cannot change the outcome. */
function sessionEnv(profile: string, tokenStore: string): Array<() => void> {
	return [
		setEnv("PI_CODING_AGENT_DIR", profile),
		setEnv("PENPI_PENFIELD_ENV", "dev"),
		setEnv("PENPI_PENFIELD_TOKEN_STORE", tokenStore),
		setEnv("PENPI_MCP_CONFIG_PATH", undefined),
		setEnv("PENPI_MCP_LIFECYCLE", undefined),
		setEnv("PENPI_PENFIELD_API_KEY", undefined),
		setEnv("PENPI_SAVE_CONTEXT_ON_SHUTDOWN", undefined),
		setEnv("PENPI_INJECT_BRIEFING", undefined),
		setEnv("PENPI_RAW", undefined),
		// PENpi must publish this itself; starting it unset proves it did.
		setEnv("PENFIELD_JWT", undefined),
	];
}

interface Session {
	runner: ExtensionRunner;
	/** Tools the agent would send to the provider. */
	active: Set<string>;
	registered(): string[];
	injected: Array<{ customType?: string; content?: unknown }>;
	appended: string[];
	errors: Array<{ extensionPath: string; event: string; error: string }>;
	/** Run a registered tool the way the agent would. */
	invoke(name: string, params: Record<string, unknown>): Promise<unknown>;
	dispose(): void;
}

/**
 * Load PENpi and the adapter through Pi's real loader and bind a real
 * ExtensionRunner, the way AgentSession does.
 *
 * The tool-registry binding is the part that matters. `registerTool()` calls
 * `runtime.refreshTools()`; AgentSession binds that to a refresh which rebuilds
 * the registry and ACTIVATES newly registered tools. Without it the adapter can
 * register all it likes and nothing becomes callable — which is precisely the
 * failure mode these tests exist to rule out, so the binding has to be present
 * and faithful.
 */
async function startSession(profile: string): Promise<Session> {
	// PENpi's duplicate-load guard lives on globalThis and is disarmed by
	// session_start. Clear it so an earlier load in this worker cannot make PENpi
	// skip registration here.
	(globalThis as { __PENPI_LOADED__?: boolean }).__PENPI_LOADED__ = false;

	const { loadExtensions } = await import(loaderPath);
	const runtime = createExtensionRuntime();
	// PENpi FIRST, adapter second — the production ordering, and the one that
	// matters: PENpi's session_start must run before the adapter reads config.
	const result = await loadExtensions([penpiEntry, adapterEntry], profile, undefined, runtime);
	expect(result.errors, "both extensions must load cleanly through Pi's loader").toEqual([]);
	expect(result.extensions.map((e: { path: string }) => e.path)).toEqual([penpiEntry, adapterEntry]);

	let runner: ExtensionRunner | undefined;
	const active = new Set<string>();
	let known = new Set<string>();
	const registered = (): string[] => runner?.getAllRegisteredTools().map((t) => t.definition.name) ?? [];
	const refreshTools = (): void => {
		const now = new Set(registered());
		for (const name of now) if (!known.has(name)) active.add(name);
		for (const name of [...active]) if (!now.has(name)) active.delete(name);
		known = now;
	};

	const injected: Array<{ customType?: string; content?: unknown }> = [];
	const appended: string[] = [];

	// Typed as the real interfaces (no cast), so a change to either contract
	// breaks this binding at compile time rather than silently degrading it.
	const actions: ExtensionActions = {
		sendMessage: (message) => {
			injected.push(message);
		},
		sendUserMessage: () => {},
		appendEntry: (customType) => {
			appended.push(customType);
		},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [...active],
		getAllTools: (): ToolInfo[] =>
			(runner?.getAllRegisteredTools() ?? []).map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				sourceInfo,
			})),
		setActiveTools: (names) => {
			active.clear();
			for (const name of names) active.add(name);
		},
		refreshTools,
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

	runner = new ExtensionRunner(
		result.extensions,
		runtime,
		profile,
		// Neither extension touches these during session_start: PENpi does not, and
		// the adapter only forwards ctx.modelRegistry into its sampling config,
		// which it skips entirely when there is no UI (as here).
		undefined as unknown as SessionManager,
		undefined as unknown as ModelRegistry,
	);
	runner.bindCore(actions, contextActions);
	runner.bindCommandContext();
	runner.setUIContext(undefined, "print");
	// The runner swallows handler exceptions into error listeners. Collect them or
	// a crash inside either extension would look like a clean run.
	const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
	runner.onError((error) => errors.push(error));
	// Seed the registry from load-time registrations (AgentSession does the same
	// during startup; before bindCore, refreshTools is a no-op).
	refreshTools();

	const boundRunner = runner;
	return {
		runner: boundRunner,
		active,
		registered,
		injected,
		appended,
		errors,
		invoke: async (name, params) => {
			const tool = boundRunner.getAllRegisteredTools().find((t) => t.definition.name === name);
			expect(tool, `tool ${name} is not registered`).toBeDefined();
			// The same entry point AgentSession's wrapper calls.
			return tool?.definition.execute(`call-${name}`, params, undefined, undefined, boundRunner.createContext());
		},
		dispose: () => boundRunner.shutdown(),
	};
}

/** Wait until `predicate` holds, or give up. Returns whether it held. */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return predicate();
}

describe("integration: Penfield direct tools across both startup paths", () => {
	it("has the prerequisites (built monorepo + installed adapter)", () => {
		// This is a setup assertion, not a PENpi assertion. It fails on a deployed
		// copy of the extension or on an unbuilt checkout, and the fix is a command,
		// so the message says which file is missing and what to run.
		expect(
			existsSync(loaderPath),
			`Pi's compiled loader is missing at:\n    ${loaderPath}\n` +
				"These integration tests drive the real loader, so the monorepo must be BUILT first:\n" +
				"    npm ci && npm run build\n" +
				"Running vitest directly against an unbuilt checkout — or against a deployed copy of\n" +
				"the extension without the monorepo — fails here. It is a prerequisite violation, not\n" +
				"a PENpi regression.",
		).toBe(true);
		expect(
			existsSync(adapterEntry),
			`pi-mcp-adapter is missing at:\n    ${adapterEntry}\nInstall dev dependencies:\n    npm ci`,
		).toBe(true);
		// The pin under test. 2.12.0 added runtime hot-registration of direct tools.
		const version = JSON.parse(readFileSync(join(adapterRoot, "package.json"), "utf8")).version as string;
		const [major, minor] = version.split(".").map(Number);
		expect(major > 2 || (major === 2 && minor >= 12), `adapter ${version} predates hot-registration`).toBe(true);
	});

	// The tests below lean on the fixture ENFORCING the bearer: they treat direct
	// tools existing, and requests succeeding, as evidence about auth. That
	// inference is only sound if a wrong bearer really is refused, and inside the
	// main flows the 401 path is unreachable — earlier assertions on the entry and
	// on PENFIELD_JWT catch any mutation that would produce one. So the enforcement
	// is pinned here, directly, where nothing shadows it.
	it("rejects a wrong bearer and serves the right one", async () => {
		const fixture = await startFixturePenfield("right-token");
		const post = (token: string): Promise<Response> =>
			fetch(`http://127.0.0.1:${fixture.port}/`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
				}),
			});
		try {
			expect((await post("wrong-token")).status).toBe(401);
			expect(fixture.rejected).toEqual(["Bearer wrong-token"]);

			expect((await post("right-token")).ok).toBe(true);
			expect(fixture.rejected, "a correct bearer must not be rejected").toEqual(["Bearer wrong-token"]);
		} finally {
			await fixture.close();
		}
	}, 30_000);

	it.skipIf(!ready)(
		"clean profile: registers and activates the direct tools before the first provider request",
		async () => {
			const profile = cleanProfile();
			const mcpPath = join(profile, "mcp.json");
			const cachePath = join(profile, "mcp-cache.json");
			const tokenStore = join(profile, "penfield-tokens-dev.json");

			// The premise of this test: the profile is empty.
			expect(existsSync(mcpPath), "profile must start with no mcp.json").toBe(false);
			expect(existsSync(cachePath), "profile must start with no adapter metadata cache").toBe(false);
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});

			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);

			let session: Session | undefined;
			try {
				session = await startSession(profile);

				// --- before session_start: only the proxy exists -----------------------
				expect(
					[...session.registered()].sort(),
					"on a clean profile the adapter must have only its proxy tool before session_start",
				).toEqual(["mcp", "search_transcript"]);
				expect([...session.active].sort()).toEqual(["mcp", "search_transcript"]);
				expect(existsSync(mcpPath), "nothing may write mcp.json before session_start").toBe(false);

				// The adapter's load-time initialization is scheduled with setImmediate;
				// give it a turn so "nothing registered yet" is a real observation rather
				// than a race we happened to win.
				await new Promise((r) => setTimeout(r, 250));
				expect(session.registered().filter((n) => n.startsWith("penfield_"))).toEqual([]);

				// --- session_start, through the real runner ----------------------------
				await session.runner.emit({ type: "session_start", reason: "startup" });
				expect(session.errors, "no extension may throw during session_start").toEqual([]);

				// PENpi generated the entry — this test never wrote one.
				expect(existsSync(mcpPath), "PENpi's session_start must generate the entry").toBe(true);
				expect(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.penfield).toMatchObject({
					url: PENFIELD_DEV_URL,
					auth: "bearer",
					bearerTokenEnv: "PENFIELD_JWT",
					directTools: true,
					// Not eager. An eager entry is read at extension load on the next run,
					// before the JWT exists — see the warm-profile test below.
					lifecycle: "lazy",
					idleTimeout: 5,
				});
				// One auth: PENpi publishes its own Penfield token for the adapter.
				expect(process.env.PENFIELD_JWT).toBe(SEEDED_TOKEN);
				// PENpi's own orientation path ran for real against the fixture.
				expect(session.appended).toContain("penpi-state");
				const briefing = session.injected.find((m) => m.customType === BRIEFING_CUSTOM_TYPE);
				expect(briefing, "PENpi must inject the orientation briefing").toBeDefined();
				expect(String(briefing?.content)).toContain(FIXTURE_BRIEFING);

				// --- the adapter's discovery hot-registers the direct tools ------------
				// No metadata cache exists, so 2.12.1 bootstraps every server here.
				await waitFor(() => session?.active.has("penfield_recall") === true);

				expect(session.errors).toEqual([]);
				expect(session.registered(), "direct tools must be registered by the adapter's discovery").toEqual(
					expect.arrayContaining(["penfield_recall", "penfield_store"]),
				);
				// Registration is not the claim. ACTIVE is the claim: present in the tool
				// set the agent would send to the provider.
				expect([...session.active], "direct tools must be ACTIVE, not merely registered").toEqual(
					expect.arrayContaining(["penfield_recall", "penfield_store"]),
				);
				expect([...session.active]).toContain("mcp");
				expect(session.runner.getActiveTools()).toEqual([...session.active]);

				// Every request the fixture served carried the token PENpi published, and
				// nothing was turned away. Recording alone would not show this — PENpi's
				// own MCP client uses the same token, so "the right bearer appeared at
				// some point" is satisfiable by PENpi's traffic even if the adapter sent
				// something else. Zero rejections is the claim that excludes that.
				expect(fixture.rejected, "no request may be rejected for bad auth").toEqual([]);
				expect(fixture.authorizations).toContain(`Bearer ${SEEDED_TOKEN}`);

				// --- and all of that happened before the first provider request --------
				// Guards against a future edit that moves an emission above this line and
				// turns "ready at startup" back into "ready after the first turn".
				expect(providerRequests, "the tools were active with no provider request emitted").toBe(0);
				providerRequests++;
				expect(await session.runner.emitBeforeProviderRequest({ messages: [] })).toEqual({ messages: [] });
				expect([...session.active]).toEqual(expect.arrayContaining(["penfield_recall", "penfield_store"]));

				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
				expect(session.errors).toEqual([]);
			} finally {
				session?.dispose();
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		90_000,
	);

	it.skipIf(!ready)(
		"warm profile: a persisted config does not connect before session_start publishes the JWT",
		async () => {
			// The regression this exists for: with `lifecycle: "eager"`, a persisted
			// mcp.json makes the adapter connect during extension LOADING — before any
			// session_start handler has published PENFIELD_JWT. It gets a 401, does not
			// retry, and the direct tools are unavailable for the entire session.
			const profile = cleanProfile();
			const mcpPath = join(profile, "mcp.json");
			const cachePath = join(profile, "mcp-cache.json");
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});

			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);

			let first: Session | undefined;
			let second: Session | undefined;
			try {
				// --- run 1: produce a genuinely warm profile ---------------------------
				// The mcp.json and metadata cache are written by PENpi and the adapter
				// themselves, so this is the state a real second launch would find —
				// not a hand-made approximation of it.
				first = await startSession(profile);
				await first.runner.emit({ type: "session_start", reason: "startup" });
				await waitFor(() => first?.active.has("penfield_recall") === true);
				await first.runner.emit({ type: "session_shutdown", reason: "quit" });
				first.dispose();
				first = undefined;

				expect(existsSync(mcpPath), "run 1 must leave an mcp.json behind").toBe(true);
				expect(existsSync(cachePath), "run 1 must leave the adapter's metadata cache behind").toBe(true);

				// --- run 2: a fresh process would start with no JWT --------------------
				delete process.env.PENFIELD_JWT;
				const requestsBefore = fixture.authorizations.length;

				second = await startSession(profile);

				// Load-time initialization is scheduled with setImmediate, so settle before
				// concluding that nothing connected. THIS is the assertion the lifecycle
				// default exists for: under `eager` the adapter connects here, with no JWT
				// published, takes a 401, and does not retry.
				await new Promise((r) => setTimeout(r, 500));
				expect(
					fixture.authorizations.length - requestsBefore,
					"nothing may contact Penfield before session_start publishes the JWT",
				).toBe(0);
				expect(process.env.PENFIELD_JWT, "the JWT must still be unpublished at this point").toBeUndefined();
				// Nor are the cached direct tools registered yet — and not merely because
				// the adapter deferred them. computeServerHash() hashes the RESOLVED
				// bearer, so with PENFIELD_JWT unset the cache entry's hash cannot match
				// and isServerCacheValid() rejects it. The cache only becomes usable once
				// PENpi has published the token, which is another reason the warm path
				// cannot be made to work before session_start.
				expect(second.registered().filter((n) => n.startsWith("penfield_"))).toEqual([]);

				// --- session_start publishes the JWT -----------------------------------
				await second.runner.emit({ type: "session_start", reason: "startup" });
				expect(second.errors).toEqual([]);
				expect(process.env.PENFIELD_JWT).toBe(SEEDED_TOKEN);

				// With the token published the cache validates, and the adapter's own
				// session_start makes the direct tools available again.
				await waitFor(() => second?.active.has("penfield_recall") === true);
				expect([...second.active], "direct tools must be active on a warm start too").toEqual(
					expect.arrayContaining(["penfield_recall", "penfield_store"]),
				);

				// --- and only now does invoking a direct tool connect ------------------
				const result = (await second.invoke("penfield_recall", { query: "anything" })) as {
					isError?: boolean;
					content?: Array<{ text?: string }>;
				};
				expect(result?.isError ?? false, `direct tool call failed: ${JSON.stringify(result)}`).toBe(false);
				expect(fixture.authorizations.length, "invoking the tool must have reached Penfield").toBeGreaterThan(
					requestsBefore,
				);
				// The connection carried the right bearer, and no 401 preceded it —
				// nothing was ever turned away across either run.
				expect(fixture.rejected, "no request may be rejected for bad auth").toEqual([]);
				expect(fixture.authorizations.every((a) => a === `Bearer ${SEEDED_TOKEN}`)).toBe(true);

				await second.runner.emit({ type: "session_shutdown", reason: "quit" });
				expect(second.errors).toEqual([]);
			} finally {
				first?.dispose();
				second?.dispose();
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		120_000,
	);
});
