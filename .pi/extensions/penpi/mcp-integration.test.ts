import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createExtensionRuntime,
	DefaultResourceLoader,
	type ExtensionActions,
	type ExtensionContextActions,
	ExtensionRunner,
	initTheme,
	type LoadExtensionsResult,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Agent, type Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { FIXTURE_BRIEFING, type FixturePenfield, startFixturePenfield } from "./__fixtures__/penfield-server.ts";
import { BRIEFING_CUSTOM_TYPE, BRIEFING_SECTION } from "./config.ts";

/**
 * Cross-package integration: PENpi and the REAL pi-mcp-adapter, which PENpi embeds
 * (ADR 0026), loaded through Pi's REAL extension loader, driven by Pi's REAL
 * ExtensionRunner, against a real MCP server. A third test proves the embedded
 * adapter never reads a project's .mcp.json or .pi/mcp.json.
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
/** Pi's built-in extensions (MCP among them), as its startup passes them to the resource loader. */
const builtinExtensionsPath = join(repoRoot, "packages", "coding-agent", "dist", "extensions", "index.js");
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
	/** Shut the session down as Pi does at exit (session_shutdown, once); safe to call again. */
	dispose(): Promise<void>;
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
async function startSession(
	profile: string,
	entry: string = penpiEntry,
	load?: () => Promise<LoadExtensionsResult>,
): Promise<Session> {
	// PENpi's duplicate-load guard lives on globalThis and is disarmed by
	// session_start. Clear it so an earlier load in this worker cannot make PENpi
	// skip registration here.
	(globalThis as { __PENPI_LOADED__?: boolean }).__PENPI_LOADED__ = false;
	// Pi's main.ts initializes the theme for every mode before extensions run; pi-mcp-adapter 7.x reads it in its
	// session_start (footer status), and the theme throws "Theme not initialized" until then.
	initTheme(undefined, false);

	let result: LoadExtensionsResult;
	if (load) {
		// The caller loads the extensions, as Pi's resource loader does at startup (built-in extensions included).
		result = await load();
	} else {
		const { loadExtensions } = await import(loaderPath);
		// PENpi ALONE: it embeds the adapter (ADR 0026), installing it after its own
		// handlers so PENpi's session_start runs before the adapter's.
		result = await loadExtensions([entry], profile, undefined, createExtensionRuntime());
		expect(result.extensions.map((e: { path: string }) => e.path)).toEqual([entry]);
	}
	expect(result.errors, "PENpi must load cleanly through Pi's loader").toEqual([]);
	const runtime = result.runtime;

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
				// Same construction as AgentSession.getAllTools().
				exposure: definition.exposure ?? "direct",
				...(definition.namespace ? { namespace: definition.namespace } : {}),
				...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
				sourceInfo,
			})),
		getSettings: () => ({}),
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
		// PENpi's context engine reads the session at session_start (its state and cut); the
		// adapter only forwards ctx.modelRegistry into its sampling config, which it skips
		// entirely when there is no UI (as here).
		SessionManager.inMemory(profile),
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
	// The runner's shutdown() only calls the mode's handler, a no-op here: emit session_shutdown so PENpi and the
	// adapter stop for real, whether or not the test got as far as its own shutdown.
	let closed = false;
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
			return tool?.definition.execute(
				`call-${name}`,
				params,
				undefined,
				undefined,
				boundRunner.createToolContext(`call-${name}`, undefined),
			);
		},
		dispose: async () => {
			if (closed) return;
			closed = true;
			await boundRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
		},
	};
}

/** The fixture's tools as the adapter registers them: direct, under `penfield_<name>`. */
const PENFIELD_TOOLS = ["awaken", "recall", "reflect", "save_context", "store"].map((t) => `penfield_${t}`);

/**
 * Every PENpi default for the adapter, as far as the running adapter shows it (0.6.0):
 * - the adapter's MCP client offers Penfield no roots (`roots: false`), no sampling and no elicitation; no request
 *   carries a local path. The adapter offers sampling and elicitation only with a UI, which this session has not, so
 *   `sampling: false` itself is held by mcp-config.test.ts;
 * - the proxy offers no save-script (`allowScriptToolSave: false`), and a semantic search is turned off
 *   (`semanticSearch: false`);
 * - an install is refused. Under a host-supplied config the adapter refuses it before reading `allowInstall`, so this
 *   shows the refusal, not the setting.
 * MCP Tasks (`tasks: false`) needs a 2026-07-28 connection, which the fixture does not offer; mcp-config.test.ts
 * covers the config.
 */
async function expectPenpiAdapterDefaults(session: Session, fixture: FixturePenfield): Promise<void> {
	const adapterClients = fixture.capabilities.filter((c) => c.client !== "penpi");
	expect(adapterClients.length, "the adapter connected to Penfield").toBeGreaterThan(0);
	for (const { client, capabilities } of adapterClients) {
		expect(capabilities, `${client} offered roots`).not.toHaveProperty("roots");
		expect(capabilities, `${client} offered sampling`).not.toHaveProperty("sampling");
		expect(capabilities, `${client} offered elicitation without a UI`).not.toHaveProperty("elicitation");
	}
	expect(fixture.fileUris, "a request to Penfield carried a local path").toEqual([]);
	const proxy = session.runner.getAllRegisteredTools().find((t) => t.definition.name === "mcp");
	expect(JSON.stringify(proxy?.definition)).not.toContain("save-script");
	const semantic = JSON.stringify(await session.invoke("mcp", { search: "recall", searchMode: "semantic" }));
	expect(semantic).toContain("Semantic search is turned off by settings.semanticSearch");
	// A regex tool search goes through recheck (4.6.2 by PENpi's npm override, 0.6.0): a safe pattern finds the tool, a
	// pattern with catastrophic backtracking is refused before it runs.
	const regex = JSON.stringify(await session.invoke("mcp", { search: "^penfield_rec(all|ord)$", regex: true }));
	expect(regex).toContain("penfield_recall");
	const unsafe = JSON.stringify(await session.invoke("mcp", { search: "^(a+)+$", regex: true }));
	expect(unsafe, "recheck ran and judged the pattern, rather than failing").toContain(
		"rejected as unsafe (vulnerable)",
	);
	expect(JSON.parse(readFileSync(join(adapterRoot, "..", "recheck", "package.json"), "utf8")).version).toBe("4.6.2");
	const install = JSON.stringify(await session.invoke("mcp", { action: "install", url: "https://example.invalid/" }));
	expect(install).toContain("programmatic_config");
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
				// (besides PENpi's own tools: transcript search and the context engine's three)
				const own = ["context_notes", "context_recall", "context_search", "search_transcript"];
				expect(
					[...session.registered()].sort(),
					"on a clean profile the adapter must have only its proxy tool before session_start",
				).toEqual(["mcp", ...own].sort());
				expect([...session.active].sort()).toEqual(["mcp", ...own].sort());
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
				// The briefing is a system prompt section on the next run, never a message (ADR 0032).
				expect(session.injected.find((m) => m.customType === BRIEFING_CUSTOM_TYPE)).toBeUndefined();
				const run = await session.runner.emitBeforeAgentStart(
					{ messageType: "user", prompt: "next task" },
					{ cwd: profile },
				);
				const briefing = run.systemPromptOptions.sections[BRIEFING_SECTION];
				expect(briefing, "PENpi must put the orientation briefing in the system prompt").toBeDefined();
				expect(briefing).toContain(FIXTURE_BRIEFING);

				// --- the adapter's discovery hot-registers the direct tools ------------
				// No metadata cache exists, so the adapter bootstraps every server here.
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
				// The tool surface, exactly (0.6.0, adapter 7.x): Penfield's tools stay direct and keep their names, with
				// no deferred `mcp__penfield__*` copies, next to the `mcp` proxy and PENpi's own tools. Registered and
				// active alike.
				const surface = ["mcp", ...own, ...PENFIELD_TOOLS].sort();
				expect([...session.registered()].sort()).toEqual(surface);
				expect([...session.active].sort()).toEqual(surface);
				await expectPenpiAdapterDefaults(session, fixture);

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
				await session?.dispose();
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
				await first.dispose();
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
				// The tool surface on a warm start, exactly: the same as on a clean one (0.6.0).
				const surface = [
					"mcp",
					"context_notes",
					"context_recall",
					"context_search",
					"search_transcript",
					...PENFIELD_TOOLS,
				].sort();
				expect([...second.registered()].sort()).toEqual(surface);
				expect([...second.active].sort()).toEqual(surface);

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
				await first?.dispose();
				await second?.dispose();
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		120_000,
	);

	for (const start of [
		{ name: "a valid access token", store: () => ({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }) },
		{
			name: "an expired access token and a valid refresh token",
			store: () => ({
				accessToken: "expired-access",
				expiresAt: Date.now() - 60_000,
				refreshToken: "stored-refresh",
			}),
		},
	]) {
		it.skipIf(!ready)(
			`eager lifecycle, ${start.name}: no request before the JWT and no 401 (0.6.0)`,
			async () => {
				// The 0.5.1 to 0.6.0 smokes' startup 401: with `penpi.mcpLifecycle: "eager"` the adapter connects while
				// extensions load, before session_start publishes the JWT. PENpi now publishes it before the adapter loads.
				const profile = cleanProfile();
				const tokenStore = join(profile, "penfield-tokens-dev.json");
				writeFileSync(tokenStore, JSON.stringify(start.store()), { mode: 0o600 });

				const fixture = await startFixturePenfield(SEEDED_TOKEN);
				const previousDispatcher = redirectTo(fixture);
				const restoreEnv = [...sessionEnv(profile, tokenStore), setEnv("PENPI_MCP_LIFECYCLE", "eager")];
				let session: Session | undefined;
				try {
					session = await startSession(profile);
					// The adapter's load-time connect is scheduled with setImmediate: let it run.
					await waitFor(() => fixture.capabilities.some((c) => c.client !== "penpi"), 5_000);
					await session.runner.emit({ type: "session_start", reason: "startup" });
					expect(session.errors).toEqual([]);
					await waitFor(() => session?.active.has("penfield_recall") === true);
					await new Promise((r) => setTimeout(r, 500));

					expect(fixture.rejected, "no request may reach Penfield without the JWT").toEqual([]);
					expect(fixture.authorizations.every((a) => a === `Bearer ${SEEDED_TOKEN}`)).toBe(true);
					// An eager entry connects twice in adapter 7.x, both times with the JWT: once while extensions load,
					// and again at session_start, which shuts the load-time state down first (its index.ts, "session_restart").
					expect(
						fixture.capabilities.filter((c) => c.client !== "penpi").length,
						"the adapter's load-time connect and its session_start connect",
					).toBe(2);
					expect(fixture.refreshes).toEqual(start.name.startsWith("an expired") ? ["stored-refresh"] : []);
					expect(session.active.has("penfield_recall")).toBe(true);
					await session.runner.emit({ type: "session_shutdown", reason: "quit" });
				} finally {
					await session?.dispose();
					for (const restore of restoreEnv.reverse()) restore();
					setGlobalDispatcher(previousDispatcher);
					await fixture.close();
				}
			},
			120_000,
		);
	}

	it.skipIf(!ready)(
		"eager lifecycle with no login: the adapter waits for session_start instead of connecting without a token (0.6.0)",
		async () => {
			const profile = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = [...sessionEnv(profile, tokenStore), setEnv("PENPI_MCP_LIFECYCLE", "eager")];
			let session: Session | undefined;
			try {
				session = await startSession(profile);
				await new Promise((r) => setTimeout(r, 1_000));
				expect(fixture.authorizations, "nothing may contact Penfield without a token").toEqual([]);
				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await session?.dispose();
				for (const restore of restoreEnv.reverse()) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		60_000,
	);

	it.skipIf(!ready)(
		"eager lifecycle, a refresh slower than the startup wait: one refresh request, not two (0.6.0)",
		async () => {
			// The startup token fetch gives up waiting after 10 s but its refresh keeps running. session_start must
			// reuse it: a second client would read the still-expired token and send the same refresh token again, which
			// a server rotating refresh tokens with reuse detection could treat as theft and end the login.
			const profile = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(
				tokenStore,
				JSON.stringify({
					accessToken: "expired-access",
					expiresAt: Date.now() - 60_000,
					refreshToken: "stored-refresh",
				}),
				{ mode: 0o600 },
			);
			const fixture = await startFixturePenfield(SEEDED_TOKEN, { tokenDelayMs: 11_500 });
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = [...sessionEnv(profile, tokenStore), setEnv("PENPI_MCP_LIFECYCLE", "eager")];
			let session: Session | undefined;
			try {
				session = await startSession(profile);
				expect(fixture.refreshes, "the startup fetch's refresh is still running").toEqual(["stored-refresh"]);
				await session.runner.emit({ type: "session_start", reason: "startup" });
				expect(session.errors).toEqual([]);
				await new Promise((r) => setTimeout(r, 500));

				expect(fixture.refreshes, "exactly one refresh request").toEqual(["stored-refresh"]);
				expect(fixture.rejected, "no request may reach Penfield without the JWT").toEqual([]);
				expect(fixture.authorizations.length, "orientation reached Penfield").toBeGreaterThan(0);
				expect(fixture.authorizations.every((a) => a === `Bearer ${SEEDED_TOKEN}`)).toBe(true);
				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await session?.dispose();
				for (const restore of restoreEnv.reverse()) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		120_000,
	);

	it.skipIf(!ready)(
		"global install: the embedded adapter loads when PENpi is reached through a symlink",
		async () => {
			// penpi-global.sh links <agentDir>/extensions/penpi to the repository's
			// extension directory. Pi loads it by the LINK path, so a module resolved
			// relative to that path searches the agent directory's node_modules, not the
			// repository's, and never finds pi-mcp-adapter. The link lives outside the
			// repository here for the same reason.
			const profile = cleanProfile();
			const extensions = cleanProfile();
			const link = join(extensions, "penpi");
			symlinkSync(here, link, "dir");
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});
			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);
			let session: Session | undefined;
			try {
				session = await startSession(profile, join(link, "index.ts"));
				// The adapter registers its `mcp` proxy tool at load: present only if it loaded.
				expect(session.registered(), "the embedded adapter did not load through the symlink").toContain("mcp");
				await session.runner.emit({ type: "session_start", reason: "startup" });
				expect(session.errors).toEqual([]);
				await waitFor(() => session?.active.has("penfield_recall") === true);
				expect([...session.active]).toEqual(expect.arrayContaining(["penfield_recall", "penfield_store"]));
				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await session?.dispose();
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		90_000,
	);

	it.skipIf(!ready)(
		"hostile project: MCP servers in the repo's .mcp.json and .pi/mcp.json are never read or started",
		async () => {
			// Security F1 (ADR 0026). The stock adapter layers project config over the
			// global file, so a repository could ship a stdio server, i.e. a local
			// command, that runs as soon as pi starts in it. Each file here defines an
			// EAGER server whose command writes a marker: if either config were read,
			// the command would run during load and leave its marker behind.
			const profile = cleanProfile();
			const project = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});
			const markers = { shared: join(project, "pwned-mcp-json"), pi: join(project, "pwned-pi-mcp-json") };
			const hostileServer = (marker: string) => ({
				command: process.execPath,
				args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
				lifecycle: "eager",
				directTools: true,
			});
			writeFileSync(
				join(project, ".mcp.json"),
				JSON.stringify({ mcpServers: { hostile: hostileServer(markers.shared) } }),
			);
			mkdirSync(join(project, ".pi"));
			writeFileSync(
				join(project, ".pi", "mcp.json"),
				JSON.stringify({ mcpServers: { hostilepi: hostileServer(markers.pi) } }),
			);

			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);
			const previousCwd = process.cwd();
			process.chdir(project);

			let session: Session | undefined;
			try {
				session = await startSession(profile);
				await session.runner.emit({ type: "session_start", reason: "startup" });
				expect(session.errors).toEqual([]);
				// Penfield still works, so the adapter is running — just not on project config.
				await waitFor(() => session?.active.has("penfield_recall") === true);
				expect([...session.active]).toEqual(expect.arrayContaining(["penfield_recall", "penfield_store"]));

				// Eager servers start during load; give a spawned command ample time to write.
				await new Promise((r) => setTimeout(r, 1_500));
				expect(existsSync(markers.shared), "a command from the project .mcp.json ran").toBe(false);
				expect(existsSync(markers.pi), "a command from the project .pi/mcp.json ran").toBe(false);
				expect(session.registered().filter((n) => n.startsWith("hostile"))).toEqual([]);

				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await session?.dispose();
				process.chdir(previousCwd);
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		90_000,
	);

	it.skipIf(!ready)(
		"Pi's built-in MCP stays out: no second Penfield client, nothing from a trusted project, other extensions' servers not connected",
		async () => {
			// pi-mcp-adapter 7.x leaves `/mcp` to Pi when it sees `pi.registerMcpServer` under a host-supplied config,
			// and Pi then keeps its built-in MCP, which reads the global mcp.json (PENpi's penfield entry: Pi 1.4
			// rejects its auth form, a Pi that accepted it would be a second Penfield client) and a trusted project's
			// .pi/mcp.json. PENpi hands the adapter an ExtensionAPI without
			// those members (withoutPiMcpServers), so the adapter registers `/mcp` and Pi leaves its built-in MCP out.
			// Loaded here the way Pi's startup loads extensions: the resource loader with the built-in extensions, in a
			// trusted project, on a warm profile (the global mcp.json already holds the penfield entry).
			const profile = cleanProfile();
			const project = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});
			writeFileSync(join(profile, "trust.json"), JSON.stringify({ [realpathSync(project)]: true }));
			const markers = {
				project: join(project, "ran-project-mcp-json"),
				extension: join(project, "ran-extension-server"),
			};
			const markerCommand = (marker: string) => ({
				command: process.execPath,
				args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
			});
			mkdirSync(join(project, ".pi"));
			writeFileSync(
				join(project, ".pi", "mcp.json"),
				JSON.stringify({
					mcpServers: { projectserver: { ...markerCommand(markers.project), exposure: "direct" } },
				}),
			);
			// Another extension registers an MCP server with Pi.
			const registrar = join(project, "registrar.ts");
			writeFileSync(
				registrar,
				`export default function (pi) { pi.registerMcpServer("extserver", ${JSON.stringify(markerCommand(markers.extension))}); }\n`,
			);

			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);
			const previousCwd = process.cwd();
			process.chdir(project);
			let first: Session | undefined;
			let session: Session | undefined;
			try {
				// A first session writes the penfield entry to the global mcp.json, as on any machine after the first run.
				first = await startSession(profile);
				await first.runner.emit({ type: "session_start", reason: "startup" });
				await first.dispose();
				expect(readFileSync(join(profile, "mcp.json"), "utf8")).toContain("penfield");
				fixture.initializations.length = 0;

				const { builtInExtensions } = await import(builtinExtensionsPath);
				let warnings: Array<{ path: string; warning: string }> = [];
				session = await startSession(profile, penpiEntry, async () => {
					const loader = new DefaultResourceLoader({
						cwd: project,
						agentDir: profile,
						settingsManager: SettingsManager.create(project, profile, { projectTrusted: true }),
						additionalExtensionPaths: [penpiEntry, registrar],
						extensionFactories: builtInExtensions,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					});
					await loader.reload();
					const loaded = loader.getExtensions();
					warnings = loaded.warnings ?? [];
					return loaded;
				});
				const loadedPaths = session.runner.getExtensionPaths();
				expect(loadedPaths, "the built-in MCP extension was loaded next to the adapter").not.toContain(
					"builtin:mcp",
				);
				expect(loadedPaths).toEqual(expect.arrayContaining([penpiEntry, registrar]));
				expect(warnings.map((w) => w.path)).toContain("builtin:mcp");

				await session.runner.emit({ type: "session_start", reason: "startup" });
				session.runner.reportUnhandledMcpServers();
				await waitFor(() => session?.active.has("penfield_recall") === true);
				expect([...session.active]).toEqual(expect.arrayContaining(["penfield_recall", "penfield_store"]));
				// Give a spawned command and a background connection ample time.
				await new Promise((r) => setTimeout(r, 1_500));

				// Penfield: PENpi's own memory client (`penpi`) and at most the adapter's, each once. Pi's built-in MCP
				// client names itself `pi` (extensions/mcp/runtime.ts).
				const clients = [...fixture.initializations].sort();
				expect(clients, "Pi's built-in MCP connected to Penfield").not.toContain("pi");
				expect(clients).toContain("penpi");
				expect(new Set(clients).size, `clients: ${clients.join(", ")}`).toBe(clients.length);
				// The trusted project's .pi/mcp.json adds nothing.
				expect(existsSync(markers.project), "a server from the trusted project's .pi/mcp.json ran").toBe(false);
				expect(session.registered().filter((n) => n.includes("projectserver"))).toEqual([]);
				// Another extension's server is reported, not connected.
				expect(existsSync(markers.extension), "a server registered by another extension ran").toBe(false);
				expect(session.registered().filter((n) => n.includes("extserver"))).toEqual([]);
				expect(session.errors).toEqual([
					expect.objectContaining({
						extensionPath: registrar,
						event: "register_mcp_server",
						error: expect.stringContaining(
							'MCP server "extserver" is registered, but no loaded extension connects',
						),
					}),
				]);
				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await first?.dispose();
				await session?.dispose();
				process.chdir(previousCwd);
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		120_000,
	);

	it.skipIf(!ready)(
		"the adapter fails to load: PENpi's own /mcp keeps Pi's built-in MCP out, and a trusted project's server never runs",
		async () => {
			// 0.6.0. Pi 1.4 leaves its built-in MCP out only because an extension registers `/mcp`. If the adapter did not
			// load, the built-in would run a trusted project's .pi/mcp.json. PENpi registers a `/mcp` of its own instead.
			// The adapter import is forced to fail: PENpi's core with an installer that imports a missing adapter.
			const profile = cleanProfile();
			const project = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});
			writeFileSync(join(profile, "trust.json"), JSON.stringify({ [realpathSync(project)]: true }));
			const marker = join(project, "ran-project-mcp-json");
			mkdirSync(join(project, ".pi"));
			writeFileSync(
				join(project, ".pi", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						projectserver: {
							command: process.execPath,
							args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
							exposure: "direct",
						},
					},
				}),
			);
			const broken = join(project, "penpi-broken-adapter.ts");
			const missingAdapter = join(project, "missing", "pi-mcp-adapter", "index.ts");
			writeFileSync(
				broken,
				[
					`import { defaultDeps, penpiCore } from ${JSON.stringify(penpiEntry)};`,
					"export default async function (pi) {",
					"\tawait penpiCore(pi, {",
					"\t\t...defaultDeps(),",
					`\t\tinstallAdapter: async () => { await import(${JSON.stringify(missingAdapter)}); },`,
					"\t});",
					"}",
					"",
				].join("\n"),
			);

			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);
			const previousCwd = process.cwd();
			process.chdir(project);
			let session: Session | undefined;
			try {
				const { builtInExtensions } = await import(builtinExtensionsPath);
				let warnings: Array<{ path: string; warning: string }> = [];
				session = await startSession(profile, broken, async () => {
					const loader = new DefaultResourceLoader({
						cwd: project,
						agentDir: profile,
						settingsManager: SettingsManager.create(project, profile, { projectTrusted: true }),
						additionalExtensionPaths: [broken],
						extensionFactories: builtInExtensions,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					});
					await loader.reload();
					const loaded = loader.getExtensions();
					warnings = loaded.warnings ?? [];
					return loaded;
				});
				expect(session.runner.getExtensionPaths(), "Pi loaded its built-in MCP").not.toContain("builtin:mcp");
				expect(warnings.map((w) => w.path)).toContain("builtin:mcp");
				expect(session.runner.getCommand("mcp")?.description).toMatch(/PENpi's MCP adapter did not load/);
				// No adapter: PENpi's own tools and those of Pi's other built-in extensions, no MCP tool.
				expect([...session.registered()].sort()).toEqual(
					[
						"codemode",
						"context_notes",
						"context_recall",
						"context_search",
						"search_transcript",
						"tool_search",
					].sort(),
				);

				await session.runner.emit({ type: "session_start", reason: "startup" });
				await new Promise((r) => setTimeout(r, 1_500));
				expect(existsSync(marker), "a server from the trusted project's .pi/mcp.json ran").toBe(false);
				expect(session.registered().filter((n) => n.includes("projectserver"))).toEqual([]);
				// PENpi itself still oriented against Penfield.
				expect(session.appended).toContain("penpi-state");
				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				await session?.dispose();
				process.chdir(previousCwd);
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		120_000,
	);

	it.skipIf(!ready)(
		"another extension's requests on the adapter's event bus get no answer: no server connected, no tool call through",
		async () => {
			// 0.6.0. pi-mcp-adapter 7.x answers requests on pi.events from any extension: register a server and connect it
			// on use, call any MCP tool (Penfield's included), open a raw MCP session. PENpi keeps the adapter off them.
			const profile = cleanProfile();
			const project = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});
			const marker = join(project, "ran-runtime-registered-server");
			const probe = join(project, "probe.ts");
			writeFileSync(probe, "export default function (pi) { globalThis.__penpiEventProbe = pi; }\n");

			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);
			let session: Session | undefined;
			try {
				session = await startSession(profile, penpiEntry, async () => {
					const { loadExtensions } = await import(loaderPath);
					return loadExtensions([penpiEntry, probe], profile, undefined, createExtensionRuntime());
				});
				await session.runner.emit({ type: "session_start", reason: "startup" });
				expect(session.errors).toEqual([]);
				await waitFor(() => session?.active.has("penfield_recall") === true);
				const api = (globalThis as { __penpiEventProbe?: { events: { emit(c: string, d: unknown): void } } })
					.__penpiEventProbe;
				expect(api, "the probe extension loaded").toBeDefined();

				const register: { result?: unknown } & Record<string, unknown> = {
					version: 1,
					name: "probeserver",
					definition: {
						command: process.execPath,
						args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
						lifecycle: "eager",
					},
				};
				api?.events.emit("pi-mcp-adapter:runtime-register:v1", register);
				const snapshot: { result?: unknown } & Record<string, unknown> = { version: 1, name: "penfield" };
				api?.events.emit("pi-mcp-adapter:runtime-snapshot:v1", snapshot);
				const requestsBefore = fixture.authorizations.length;
				const call: { result?: unknown } & Record<string, unknown> = {
					version: 1,
					tool: "penfield_recall",
					args: { query: "probe" },
				};
				api?.events.emit("pi-mcp-adapter:runtime-tool-call:v1", call);
				const protocol: { result?: unknown; error?: unknown } & Record<string, unknown> = {
					version: 1,
					definition: { namespace: "probe", requests: ["probe/ask"], streams: [], notifications: [] },
				};
				api?.events.emit("pi-mcp-adapter:protocol:v1", protocol);

				expect(register.result, "the adapter answered a runtime registration").toBeUndefined();
				expect(snapshot.result, "the adapter answered a runtime snapshot").toBeUndefined();
				expect(call.result, "the adapter answered a runtime tool call").toBeUndefined();
				expect(protocol.result ?? protocol.error, "the adapter answered a protocol registration").toBeUndefined();
				await new Promise((r) => setTimeout(r, 1_500));
				expect(existsSync(marker), "a runtime-registered server ran").toBe(false);
				expect(session.registered().filter((n) => n.includes("probeserver"))).toEqual([]);
				expect(fixture.authorizations.length - requestsBefore, "a runtime tool call reached Penfield").toBe(0);
				// The adapter itself still works.
				const result = (await session.invoke("penfield_recall", { query: "anything" })) as { isError?: boolean };
				expect(result?.isError ?? false).toBe(false);
				await session.runner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				(globalThis as { __penpiEventProbe?: unknown }).__penpiEventProbe = undefined;
				await session?.dispose();
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		120_000,
	);

	it.skipIf(!ready)(
		"a disposed session is shut down: it reaches Penfield no more, even when a test throws before its own shutdown",
		async () => {
			// 0.5.1: dispose() used to call the runner's shutdown handler, which this harness binds to a no-op, so a
			// test that threw before emitting session_shutdown left PENpi's client and the adapter running, and their
			// later requests reached the next test's fixture. dispose() now emits session_shutdown (once).
			const profile = cleanProfile();
			const tokenStore = join(profile, "penfield-tokens-dev.json");
			writeFileSync(tokenStore, JSON.stringify({ accessToken: SEEDED_TOKEN, expiresAt: Date.now() + 3_600_000 }), {
				mode: 0o600,
			});
			const fixture = await startFixturePenfield(SEEDED_TOKEN);
			const previousDispatcher = redirectTo(fixture);
			const restoreEnv = sessionEnv(profile, tokenStore);
			let session: Session | undefined;
			try {
				session = await startSession(profile);
				await session.runner.emit({ type: "session_start", reason: "startup" });
				expect(session.appended, "PENpi oriented against the fixture").toContain("penpi-state");
				// As a test that throws here would: no session_shutdown of its own, only the cleanup.
				await session.dispose();
				const before = fixture.authorizations.length;
				// A run ending after the cleanup would make a live session read its memory again (awaken + reflect).
				await session.runner.emit({ type: "agent_end", messages: [] });
				await new Promise((r) => setTimeout(r, 500));
				expect(fixture.authorizations.length - before, "a disposed session must not contact Penfield").toBe(0);
			} finally {
				await session?.dispose();
				for (const restore of restoreEnv) restore();
				setGlobalDispatcher(previousDispatcher);
				await fixture.close();
			}
		},
		90_000,
	);
});
