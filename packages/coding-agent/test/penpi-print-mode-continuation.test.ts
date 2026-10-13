/**
 * Print mode with PENpi length continuation (ADR 0028), against the real AgentSession.
 *
 * `pi -p` used to print only the last assistant message, so an answer continued after an
 * output-limit stop came out as its final part only. stdout must carry the complete final
 * answer, every continuation part and nothing else; a budget that runs out exits non-zero
 * with one line on stderr.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LENGTH_CONTINUATIONS, penpiCore } from "../../../.pi/extensions/penpi/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
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

function runtimeFor(h: Harness) {
	return {
		session: h.session,
		setRebindSession: () => {},
		newSession: async () => undefined,
		fork: async () => ({ cancelled: true }),
		switchSession: async () => undefined,
		dispose: async () => {},
	} as unknown as Parameters<typeof runPrintMode>[0];
}

async function printMode(h: Harness, prompt: string) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array,
		...rest: any[]
	) => {
		stdout.push(String(chunk));
		const callback = rest.find((arg) => typeof arg === "function");
		callback?.();
		return true;
	}) as typeof process.stdout.write);
	const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderr.push(args.map(String).join(" "));
	});
	try {
		const exitCode = await runPrintMode(runtimeFor(h), { mode: "text", initialMessage: prompt });
		return { exitCode, stdout: stdout.join(""), stderr };
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
	}
}

describe("print mode with PENpi length continuation", () => {
	let h: Harness | undefined;
	let agentDir: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "penpi-print-agent-"));
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

	it("prints every continuation part of the final answer", async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [cutOff("The answer starts here, "), cutOff("goes on here, "), "and ends here."],
			extensionFactories: [penpi],
		});

		const result = await printMode(h, "write it all");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("The answer starts here, goes on here, and ends here.\n");
		expect(result.stderr).toEqual([]);
	});

	it("leaves out narration from tool steps before the final answer", async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [
				{ text: "Let me look at the file first.", toolCalls: [{ name: "read", args: { path: "missing.txt" } }] },
				cutOff("Final part one, "),
				"final part two.",
			],
			extensionFactories: [penpi],
		});

		const result = await printMode(h, "answer after a tool step");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Final part one, final part two.\n");
	});

	it(`exits non-zero with one stderr line when ${MAX_LENGTH_CONTINUATIONS} continuations are not enough`, async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: [cutOff("A"), cutOff("B"), cutOff("C"), cutOff("D"), "UNREACHED"],
			extensionFactories: [penpi],
		});

		const result = await printMode(h, "never finishes");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toHaveLength(1);
		expect(result.stderr[0]).toMatch(/output token limit/);
		expect(result.stdout).not.toContain("UNREACHED");
	});

	it("still prints a plain answer unchanged", async () => {
		h = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 200_000 },
			responses: ["Just one part."],
			extensionFactories: [penpi],
		});

		const result = await printMode(h, "hi");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Just one part.\n");
	});
});
