import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import penpi, { penpiCore } from "./index.ts";

// --- Fakes -----------------------------------------------------------------

type Handler = (event: any, ctx: any) => any;

function makeFakePi(flagValues: Record<string, boolean> = {}) {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, Handler> = {};
	const tools: Record<string, any> = {};
	const registeredFlags: Array<{ name: string; options: Record<string, unknown> }> = [];
	const sent: any[] = [];
	const entries: any[] = [];
	const pi = {
		registerFlag: (name: string, options: Record<string, unknown>) => registeredFlags.push({ name, options }),
		getFlag: (n: string) => flagValues[n] ?? false,
		registerCommand: (n: string, o: { handler: Handler }) => {
			commands[n] = o.handler;
		},
		registerTool: (t: { name: string }) => {
			tools[t.name] = t;
		},
		on: (e: string, h: Handler) => {
			handlers[e] = h;
		},
		sendMessage: (m: unknown) => sent.push(m),
		appendEntry: (t: string, d: unknown) => entries.push({ t, d }),
	};
	return { pi, handlers, commands, tools, registeredFlags, sent, entries };
}

function makeCtx(usage?: { tokens: number | null; contextWindow: number }) {
	const notifies: Array<{ msg: string; level?: string }> = [];
	return {
		ctx: {
			cwd: "/tmp/penpi-test-cwd",
			ui: { notify: (msg: string, level?: string) => notifies.push({ msg, level }) },
			getContextUsage: () => usage,
		},
		notifies,
	};
}

function makeStubClient(over: Partial<Record<string, any>> = {}) {
	const calls: string[] = [];
	const client: any = {
		connected: true,
		hasNonInteractiveAuth: () => over.auth ?? true,
		getAccessToken: vi.fn(async () => "jwt-token"),
		connect: vi.fn(async () => {
			calls.push("connect");
		}),
		disconnect: vi.fn(async () => {
			calls.push("disconnect");
		}),
		awaken: vi.fn(async () => {
			calls.push("awaken");
			return { isError: false, data: { briefing: "BRIEFING-TEXT" }, text: "BRIEFING-TEXT" };
		}),
		reflect: vi.fn(async () => {
			calls.push("reflect");
			return { isError: false, data: "r", text: "REFLECT-TEXT" };
		}),
		saveContext: vi.fn(async () => {
			calls.push("saveContext");
			return { isError: false, data: "", text: "" };
		}),
		login: vi.fn(async () => "jwt-token"),
		...over,
	};
	return { client, calls };
}

const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 0 });

beforeEach(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("PENPI_") || k === "PENFIELD_JWT") delete process.env[k];
});
afterEach(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("PENPI_") || k === "PENFIELD_JWT") delete process.env[k];
	(globalThis as { __PENPI_LOADED__?: boolean }).__PENPI_LOADED__ = undefined;
});

function load(flags: Record<string, boolean> = {}, clientOver: Record<string, any> = {}) {
	const f = makeFakePi(flags);
	const stub = makeStubClient(clientOver);
	// Inject a no-op mcp.json writer so the unit test never touches disk.
	penpiCore(f.pi as never, { makeClient: () => stub.client, ensureMcpEntry: () => "/tmp/penpi-test-mcp.json" });
	return { ...f, stub };
}

describe("penpiCore registration", () => {
	it("registers the four hooks, command, two flags, and transcript tool", () => {
		const { handlers, commands, tools, registeredFlags } = load();
		expect(Object.keys(handlers).sort()).toEqual(
			["context", "session_before_compact", "session_shutdown", "session_start"].sort(),
		);
		expect(commands.penpi).toBeTypeOf("function");
		expect(tools.search_transcript).toBeTruthy();
		expect(registeredFlags.map((flag) => flag.name)).toEqual(["penpi-dev", "penpi-raw"]);
		expect(registeredFlags[0]?.options.hidden).toBe(true);
	});
});

describe("session_before_compact", () => {
	it("always cancels", async () => {
		const { handlers } = load();
		await expect(handlers.session_before_compact({}, {})).resolves.toEqual({ cancel: true });
	});
});

describe("context (FIFO) hook", () => {
	it("prunes when over the ceiling", async () => {
		const { handlers } = load();
		const messages = Array.from({ length: 30 }, (_, i) => user(`m${i} ${"A".repeat(400)}`));
		const { ctx } = makeCtx({ tokens: 900_000, contextWindow: 1000 });
		const r = await handlers.context({ messages }, ctx);
		expect(r?.messages.length).toBeLessThan(messages.length);
	});
	it("no-ops under the ceiling", async () => {
		const { handlers } = load();
		const { ctx } = makeCtx({ tokens: 10, contextWindow: 1_000_000 });
		expect(await handlers.context({ messages: [user("hi")] }, ctx)).toBeUndefined();
	});
	it("no-ops when usage is unknown", async () => {
		const { handlers } = load();
		const { ctx } = makeCtx(undefined);
		expect(await handlers.context({ messages: [user("hi")] }, ctx)).toBeUndefined();
	});
});

describe("session_start orientation", () => {
	it("skips cleanly when Penfield is not authenticated", async () => {
		const { handlers, sent, stub } = load({}, { auth: false });
		const { ctx, notifies } = makeCtx();
		await handlers.session_start({ reason: "startup" }, ctx);
		expect(stub.client.awaken).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(notifies.some((n) => /not authenticated|login/i.test(n.msg))).toBe(true);
	});

	it("injects the briefing when authenticated (normal mode)", async () => {
		const { handlers, sent, entries, stub } = load({}, { auth: true });
		const { ctx } = makeCtx();
		await handlers.session_start({ reason: "startup" }, ctx);
		expect(stub.client.awaken).toHaveBeenCalled();
		expect(stub.client.reflect).toHaveBeenCalled();
		expect(sent[0]?.customType).toBe("penpi-briefing");
		expect(sent[0]?.content).toContain("BRIEFING-TEXT");
		expect(sent[0]?.content).toContain("BEGIN PENFIELD PERSISTENT MEMORY");
		expect(sent[0]?.content).toContain("trusted persistent context");
		expect(sent[0]?.content).toContain("does not override current system/developer/user instructions");
		expect(sent[0]?.content).toContain("END PENFIELD PERSISTENT MEMORY");
		expect(entries.some((e) => e.t === "penpi-state")).toBe(true);
	});

	it("raw diagnostic mode skips automatic orientation but keeps the connection active", async () => {
		const { handlers, sent, stub } = load({ "penpi-raw": true }, { auth: true });
		const { ctx, notifies } = makeCtx();
		await handlers.session_start({ reason: "startup" }, ctx);
		expect(stub.client.connect).toHaveBeenCalled();
		expect(stub.client.awaken).not.toHaveBeenCalled();
		expect(stub.client.reflect).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(notifies.some((n) => /raw diagnostic mode/i.test(n.msg))).toBe(true);
	});
});

describe("session_shutdown", () => {
	it("disconnects and does not save_context by default (opt-in)", async () => {
		const { handlers, stub } = load({}, { auth: true });
		await handlers.session_start({ reason: "startup" }, makeCtx().ctx);
		await handlers.session_shutdown({ reason: "quit" }, {});
		expect(stub.client.saveContext).not.toHaveBeenCalled();
		expect(stub.client.disconnect).toHaveBeenCalled();
	});

	it("saves a checkpoint on real exit when saveContextOnShutdown is enabled", async () => {
		process.env.PENPI_SAVE_CONTEXT_ON_SHUTDOWN = "true";
		const { handlers, stub } = load({}, { auth: true });
		await handlers.session_start({ reason: "startup" }, makeCtx().ctx);
		await handlers.session_shutdown({ reason: "quit" }, {});
		expect(stub.client.saveContext).toHaveBeenCalled();
		expect(stub.client.disconnect).toHaveBeenCalled();
	});

	it("does NOT save on a hot reload even when enabled", async () => {
		process.env.PENPI_SAVE_CONTEXT_ON_SHUTDOWN = "true";
		const { handlers, stub } = load({}, { auth: true });
		await handlers.session_start({ reason: "startup" }, makeCtx().ctx);
		await handlers.session_shutdown({ reason: "reload" }, {});
		expect(stub.client.saveContext).not.toHaveBeenCalled();
	});
});

describe("dedupe guard (default export)", () => {
	it("loads once per process — a second load is a no-op", () => {
		const a = makeFakePi();
		penpi(a.pi as never);
		const b = makeFakePi();
		penpi(b.pi as never);
		expect(Object.keys(a.handlers).length).toBeGreaterThan(0);
		expect(Object.keys(b.handlers).length).toBe(0);
	});
});

describe("/penpi login command", () => {
	it("runs login then orients (injects briefing)", async () => {
		const { commands, sent, stub } = load({}, { auth: true });
		const { ctx, notifies } = makeCtx();
		await commands.penpi("login", ctx);
		expect(stub.client.login).toHaveBeenCalled();
		expect(stub.client.awaken).toHaveBeenCalled();
		expect(sent[0]?.customType).toBe("penpi-briefing");
		expect(notifies.some((n) => /login complete/i.test(n.msg))).toBe(true);
	});

	it("surfaces an error and disconnects when login fails", async () => {
		const { commands, stub } = load(
			{},
			{
				auth: true,
				login: vi.fn(async () => {
					throw new Error("denied");
				}),
			},
		);
		const { ctx, notifies } = makeCtx();
		await commands.penpi("login", ctx);
		expect(notifies.some((n) => n.level === "error" && /denied/i.test(n.msg))).toBe(true);
		expect(stub.client.disconnect).toHaveBeenCalled();
	});

	it("status (no arg) reports injection + FIFO state without throwing", async () => {
		const { commands } = load();
		const { ctx, notifies } = makeCtx();
		await commands.penpi("", ctx);
		expect(notifies.some((n) => /PENpi status/.test(n.msg))).toBe(true);
	});
});

describe("duplicate-load guard", () => {
	beforeEach(() => {
		(globalThis as { __PENPI_LOADED__?: boolean }).__PENPI_LOADED__ = false;
	});

	it("skips a second copy discovered in the SAME load pass", () => {
		// Global install + project-local copy: pi finds both, only one may register.
		const a = makeFakePi();
		const b = makeFakePi();
		penpi(a.pi as any);
		penpi(b.pi as any);
		expect(Object.keys(a.handlers)).toContain("session_start");
		expect(Object.keys(b.handlers)).toHaveLength(0);
	});

	it("registers again on a later /reload (guard disarms after the load pass)", async () => {
		const first = makeFakePi();
		penpi(first.pi as any);
		expect(Object.keys(first.handlers)).toContain("session_start");

		// session_start marks the end of the load pass.
		const { ctx } = makeCtx();
		await first.handlers.session_start({ reason: "startup" }, ctx);

		// /reload re-imports every extension against a fresh runner — PENpi must
		// register, or the session is left with no FIFO and no compaction.
		const reloaded = makeFakePi();
		penpi(reloaded.pi as any);
		expect(Object.keys(reloaded.handlers)).toContain("session_start");
		expect(reloaded.tools.search_transcript).toBeDefined();
	});
});
