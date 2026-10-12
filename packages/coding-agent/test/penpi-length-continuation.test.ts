/**
 * PENpi length continuation (ADR 0028) inside the real AgentSession.
 *
 * A response that stops at the model's output limit (stopReason "length") used to end the
 * run as if it were finished. PENpi's agent_end handler queues a follow-up asking the model
 * to continue; these tests run that against pi's real post-run handling, which is what
 * turns a message queued during agent_end into another turn of the same run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LENGTH_CONTINUATION_PROMPT,
	MAX_LENGTH_CONTINUATIONS,
	penpiCore,
} from "../../../.pi/extensions/penpi/index.ts";
import { createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.ts";

// Penfield is never authenticated here: orientation skips, only the run hooks matter.
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

const cutOff = (text: string) => ({ text, stopReason: "length" as const, usage: { output: 16_384 } });

async function waitForIdle(h: Harness) {
	for (let i = 0; i < 400; i++) {
		if (h.session.isIdle && !h.session.isCompacting) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("session did not settle");
}

const persisted = (h: Harness) =>
	(h.sessionManager.getEntries() as any[]).filter((e) => e.type === "message").map((e) => e.message);
const text = (m: any) =>
	typeof m.content === "string" ? m.content : m.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
const transcript = (h: Harness) =>
	persisted(h)
		.filter((m) => m.role !== "system")
		.map((m) => `${m.role}: ${text(m)}`);
const continuation = `user: ${LENGTH_CONTINUATION_PROMPT}`;

describe("PENpi length continuation in AgentSession", () => {
	let h: Harness | undefined;
	let agentDir: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "penpi-continue-agent-"));
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});
	afterEach(() => {
		h?.cleanup();
		h = undefined;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("continues a response cut off at the output limit, in the same run", async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [cutOff("PART-1"), "PART-2"],
			extensionFactories: [penpi],
		});
		await h.session.prompt("write it all");
		await waitForIdle(h);
		expect(transcript(h)).toEqual(["user: write it all", "assistant: PART-1", continuation, "assistant: PART-2"]);
		// One run: pi drained the queued follow-up before settling.
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it(`stops after ${MAX_LENGTH_CONTINUATIONS} continuations in one run`, async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [cutOff("C0"), cutOff("C1"), cutOff("C2"), cutOff("C3"), cutOff("C4"), "UNREACHED"],
			extensionFactories: [penpi],
		});
		await h.session.prompt("write it all");
		await waitForIdle(h);
		expect(transcript(h)).toEqual([
			"user: write it all",
			"assistant: C0",
			continuation,
			"assistant: C1",
			continuation,
			"assistant: C2",
			continuation,
			"assistant: C3",
		]);
	});

	it("gives every new prompt its own budget", async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [cutOff("A0"), cutOff("A1"), cutOff("A2"), cutOff("A3"), cutOff("B0"), "B1"],
			extensionFactories: [penpi],
		});
		await h.session.prompt("first");
		await waitForIdle(h);
		await h.session.prompt("second");
		await waitForIdle(h);
		const lines = transcript(h);
		expect(lines.slice(lines.indexOf("user: second"))).toEqual([
			"user: second",
			"assistant: B0",
			continuation,
			"assistant: B1",
		]);
	});

	it("leaves an ordinary stop alone", async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: ["DONE"],
			extensionFactories: [penpi],
		});
		await h.session.prompt("hi");
		await waitForIdle(h);
		expect(transcript(h)).toEqual(["user: hi", "assistant: DONE"]);
	});
});
