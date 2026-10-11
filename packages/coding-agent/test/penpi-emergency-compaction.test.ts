/**
 * PENpi emergency compaction (ADR 0025) inside the real AgentSession.
 *
 * The extension's unit tests call its agent_settled handler directly; these run the actual
 * penpiCore against pi's event ordering, which is where the agent_end version broke: a
 * retry after agent_end ran while ctx.compact() had disconnected the session, so the
 * recovered reply was never persisted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { penpiCore } from "../../../.pi/extensions/penpi/index.ts";
import { createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.ts";

const big = "x".repeat(48_000); // ~12k estimated tokens per message

// Penfield is never authenticated here: orientation skips, only context management runs.
const penpi = (pi: any) =>
	penpiCore(pi, {
		makeClient: () =>
			({
				connected: false,
				hasNonInteractiveAuth: () => false,
				disconnect: async () => {},
			}) as any,
		ensureMcpEntry: () => "",
	});

// The harness builds its Agent without the extension `context` hook; wire it as sdk.ts
// does so PENpi's FIFO hook sees each LLM call (and the model's window) like in production.
async function createPenpiHarness(options: Parameters<typeof createHarnessWithExtensions>[0]): Promise<Harness> {
	const harness = await createHarnessWithExtensions({ ...options, extensionFactories: [penpi] });
	harness.agent.transformContext = (messages) => harness.session.extensionRunner.emitContext(messages);
	return harness;
}

async function waitForIdle(h: Harness) {
	for (let i = 0; i < 400; i++) {
		if (h.session.isIdle && !h.session.isCompacting) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("session did not settle");
}

function assistantTexts(messages: any[]): string[] {
	return messages
		.filter((m) => m.role === "assistant")
		.map((m) => m.content.map((c: any) => (c.type === "text" ? c.text : "")).join(""));
}
const persistedMessages = (h: Harness) =>
	(h.sessionManager.getEntries() as any[]).filter((e) => e.type === "message").map((e) => e.message);
const compactionEntries = (h: Harness) =>
	(h.sessionManager.getEntries() as any[]).filter((e) => e.type === "compaction");

describe("PENpi emergency compaction in AgentSession", () => {
	let h: Harness | undefined;
	let agentDir: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		process.env.PENPI_EMERGENCY_COMPACTION_RUNS = "2";
		process.env.PENPI_INJECT_BRIEFING = "false";
		// penpi reads pi's settings files for keepRecentTokens; keep the real ~/.pi out of it.
		agentDir = mkdtempSync(join(tmpdir(), "penpi-e2e-agent-"));
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});
	afterEach(() => {
		h?.cleanup();
		h = undefined;
		delete process.env.PENPI_EMERGENCY_COMPACTION_RUNS;
		delete process.env.PENPI_INJECT_BRIEFING;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("compacts once, after a retry on the threshold run has recovered and been persisted", async () => {
		h = await createPenpiHarness({
			model: { ...fauxModel, contextWindow: 0 },
			responses: [`a1 ${big}`, { error: "503 overloaded_error: Overloaded" }, "RECOVERED-REPLY", "SUMMARY"],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});

		await h.session.prompt(`q1 ${big}`);
		await waitForIdle(h);
		expect(compactionEntries(h)).toHaveLength(0); // run 1 of 2

		await h.session.prompt(`q2 ${big}`); // run 2: 503, retry, recovery, then settle
		await waitForIdle(h);

		// The retry happened and recovered before the emergency compaction started.
		const types = h.events.map((e) => e.type);
		expect(types).toContain("auto_retry_start");
		expect(types.indexOf("compaction_start")).toBeGreaterThan(types.lastIndexOf("auto_retry_start"));

		// The recovered reply is persisted and still in live context after compaction.
		expect(assistantTexts(persistedMessages(h))).toContain("RECOVERED-REPLY");
		expect(assistantTexts(h.agent.state.messages)).toContain("RECOVERED-REPLY");

		// Exactly one compaction, the forced manual one, and it succeeded.
		expect(compactionEntries(h)).toHaveLength(1);
		const ends = h.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ reason: "manual", aborted: false });
		expect(ends[0].errorMessage).toBeUndefined();
	});

	it("arms after a switch from a windowed model to one without a window", async () => {
		h = await createPenpiHarness({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [`a0 ${big}`, `a1 ${big}`, `a2 ${big}`, "SUMMARY", "a3"],
		});

		await h.session.prompt(`q0 ${big}`); // windowed: FIFO is active
		await waitForIdle(h);

		// Switch to a model whose metadata has no context window (no model_select event).
		h.agent.state.model = { ...h.agent.state.model, contextWindow: 0 } as any;
		expect(h.session.getContextUsage()).toBeUndefined();

		await h.session.prompt(`q1 ${big}`);
		await waitForIdle(h);
		expect(compactionEntries(h)).toHaveLength(0);
		await h.session.prompt(`q2 ${big}`);
		await waitForIdle(h);
		expect(compactionEntries(h)).toHaveLength(1);
	});

	it("finishes the compaction before the run settles", async () => {
		// Awaited inside agent_settled, so prompt() and waitForIdle() resolve only once the
		// compaction is done: print mode cannot exit, and the next prompt cannot start, while
		// it is still running.
		h = await createPenpiHarness({
			model: { ...fauxModel, contextWindow: 0 },
			responses: [`a1 ${big}`, `a2 ${big}`, "SUMMARY"],
		});
		await h.session.prompt(`q1 ${big}`);
		await h.session.prompt(`q2 ${big}`);
		// No polling loop here: the compaction must already be complete.
		expect(compactionEntries(h)).toHaveLength(1);
		expect(h.session.isCompacting).toBe(false);
		expect(h.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ reason: "manual", aborted: false })]);
	});

	it("never compacts on a windowed model, however many runs", async () => {
		h = await createPenpiHarness({
			model: { ...fauxModel, contextWindow: 1_000_000 },
			responses: [`a ${big}`],
		});
		// Also guards the wiring above: without the context hook FIFO never sees the window
		// and the emergency path would compact here.
		for (let i = 0; i < 4; i++) {
			await h.session.prompt(`q${i} ${big}`);
			await waitForIdle(h);
		}
		expect(compactionEntries(h)).toHaveLength(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});
});
