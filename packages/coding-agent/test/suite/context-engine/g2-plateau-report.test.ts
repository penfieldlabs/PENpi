/**
 * G2: when the silent-truncation detector fires, the answers that were produced from truncated input
 * are named (entry id, assistant turn number, time) in the decision log, in a warning that says they
 * may be unreliable, and in a session entry. The plateau window is kept for this session only, shown
 * in /penpi doctor, and cleared by /penpi reset-limits.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, newStats, STATE_TYPE } from "./engine.ts";
import { installProviderSim, report, runPrompts, scriptedModel, workExtension } from "./helpers.ts";

const SILENT_LIMIT = 24_000;
const MODEL = { id: "local-64k", contextWindow: 64_000, maxTokens: 8_000 };

async function setup() {
	const stats = newStats();
	const notices: Array<{ message: string; type?: string }> = [];
	const statuses: string[] = [];
	const lines: string[] = [];
	const harness = await createHarness({
		models: [MODEL],
		settings: { compaction: { enabled: false } },
		extensionFactories: [workExtension, createContextEngine({ stats, log: (line) => lines.push(line) })],
	});
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({
			notify: (message, type) => notices.push({ message, type }),
			setStatus: (_key, text) => {
				if (text) statuses.push(text);
			},
		}),
	});
	return { stats, notices, statuses, lines, harness };
}

async function command(t: Awaited<ReturnType<typeof setup>>, text: string): Promise<string> {
	const before = t.notices.length;
	await t.harness.session.prompt(text);
	return t.notices
		.slice(before)
		.map((n) => n.message)
		.join("\n");
}

describe("G2: answers from silently truncated input", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("g2 names the truncated turns in the log, a warning and a session entry; doctor shows them; reset clears", async () => {
		const t = await setup();
		harnesses.push(t.harness);
		const sim = installProviderSim(t.harness, { silentLimit: SILENT_LIMIT });
		const model = scriptedModel(t.harness);
		await runPrompts(t.harness, model, { prompts: 6, turns: 25 });

		// Every request succeeded, so call i produced the i-th assistant message on the branch.
		const assistants = t.harness.sessionManager
			.getBranch()
			.filter((e) => e.type === "message" && e.message.role === "assistant");
		const truncatedTurns = sim.calls.flatMap((c, i) => (c.truncatedInput ? [i + 1] : []));
		const reportEntry = t.stats.plateauReports[0];
		const named = reportEntry?.turns ?? [];
		const warning = t.notices.find((n) => n.message.includes("may be unreliable"));
		const logLines = t.lines.filter((l) => l.includes("plateau: truncated answer"));
		const persisted = t.harness.sessionManager
			.getEntries()
			.filter(
				(e) =>
					e.type === "custom" && e.customType === STATE_TYPE && (e.data as { kind?: string }).kind === "plateau",
			);
		const doctorBefore = await command(t, "/penpi doctor");
		const learnedLine = doctorBefore.split("\n").find((l) => l.includes("(plateau;"));
		const statusBefore = t.statuses.at(-1);
		const reset = await command(t, "/penpi reset-limits");
		const doctorAfter = await command(t, "/penpi doctor");
		report("g2", ENGINE_LABEL, "report", {
			truncatedTurns,
			named,
			warning: warning?.message,
			logLines,
			persisted: persisted.length,
			learnedLine,
			statusBefore,
			reset,
			statusAfter: t.statuses.at(-1),
			learnedAfter: doctorAfter.split("\n").find((l) => l.startsWith("learned windows")),
		});

		// Named: every answer produced from truncated input, with a real entry id, turn number and time.
		expect(named.length).toBeGreaterThanOrEqual(2);
		expect(named.map((n) => n.turn)).toEqual(truncatedTurns);
		for (const turn of named) {
			const entry = assistants[(turn.turn ?? 0) - 1];
			expect(entry?.id).toBe(turn.entryId);
			expect(new Date((entry as { message: AssistantMessage }).message.timestamp).toISOString()).toBe(turn.at);
		}
		// The warning, the log and the session entry carry them.
		expect(warning?.type).toBe("warning");
		for (const turn of named) {
			expect(warning?.message).toContain(`turn ${turn.turn} (entry ${turn.entryId}, ${turn.at})`);
			expect(logLines.some((l) => l.includes(`entry=${turn.entryId} turn=${turn.turn} at=${turn.at}`))).toBe(true);
		}
		expect(warning?.message).toMatch(/system prompt, window header, pinned task/);
		expect(warning?.message).toContain("for this session only; /penpi reset-limits clears it");
		expect(persisted).toHaveLength(1);
		// Doctor: the plateau window, session-only, never re-probed, the turns, and the reset command.
		expect(learnedLine).toMatch(/: 2\d,\d{3} \(plateau; .*this session only, never re-probed/);
		expect(learnedLine).toContain(`turn ${named[0].turn} (entry ${named[0].entryId})`);
		expect(learnedLine).toContain("clear with /penpi reset-limits");
		expect(statusBefore).toMatch(/^ctx 2\dk \(model 64k, learned\(plateau\)\)/);
		// Reset: the window is the model's again.
		expect(reset).toMatch(/learned limits cleared for this session: faux\/local-64k: window 2\d{4} \(plateau\)/);
		expect(doctorAfter).toContain("learned windows: none");
		expect(doctorAfter).toContain("effective window: 64,000 (reason: metadata");
		expect(t.statuses.at(-1)).toMatch(/^ctx 64k · /);
	});

	it("g2 a plateau window is kept for its session only: a new session starts clean", async () => {
		const first = await setup();
		harnesses.push(first.harness);
		installProviderSim(first.harness, { silentLimit: SILENT_LIMIT });
		await runPrompts(first.harness, scriptedModel(first.harness), { prompts: 4, turns: 25 });
		const snapshot = [...first.harness.sessionManager.getEntries()]
			.reverse()
			.find((e) => e.type === "custom" && (e.data as { kind?: string; learned?: unknown }).kind === "model");
		const learned = (snapshot as { data: { learned?: { source?: string; scope?: string } } } | undefined)?.data
			.learned;
		const second = await setup();
		harnesses.push(second.harness);
		installProviderSim(second.harness);
		await runPrompts(second.harness, scriptedModel(second.harness), { prompts: 1, turns: 3 });
		const doctor = await command(second, "/penpi doctor");
		expect(learned).toMatchObject({ source: "plateau", scope: "session" });
		expect(doctor).toContain("learned windows: none");
	});
});
