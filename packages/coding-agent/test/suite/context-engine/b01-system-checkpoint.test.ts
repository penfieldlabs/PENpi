/**
 * Behaviours without a test, item 1 (E2.11): system messages before a cut fold into one checkpoint at the
 * head of the request; a system message after the cut stays in place.
 */

import type { Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { runPrompts, scriptedModel, workExtension } from "./helpers.ts";

type System = Extract<Message, { role: "system" }>;

describe("E2.11: system messages and the checkpoint", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("b01 two system messages before a cut and one after: one checkpoint, the later one in place", async () => {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let last: Message[] = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, o) => {
			last = context.messages as Message[];
			return inner(m, context, o);
		};
		const model = scriptedModel(harness, 2_000);
		const all = harness.session.getActiveToolNames();
		const without = (...names: string[]) => all.filter((n) => !names.includes(n));
		// The first prompt declares the tools; each change of the active set writes a system message.
		await runPrompts(harness, model, { prompts: 1, turns: 1, seedBase: 1 });
		harness.session.setActiveToolsByName(without("context_search"));
		await runPrompts(harness, model, { prompts: 1, turns: 2, seedBase: 2 });
		harness.session.setActiveToolsByName(without("context_search", "context_notes"));
		const beforeCut = harness.session.getActiveToolNames();
		await runPrompts(harness, model, { prompts: 1, turns: 2, seedBase: 3 });
		const systemsBefore = harness.session.messages.filter((m) => m.role === "system").length;
		// Enough work for cuts that move past all of them.
		await runPrompts(harness, model, { prompts: 6, turns: 10, min: 4_000, spread: 3_000, seedBase: 10 });
		expect(stats.cuts.length).toBeGreaterThan(0);
		harness.session.setActiveToolsByName(without("context_notes"));
		await runPrompts(harness, model, { prompts: 1, turns: 1, seedBase: 90 });

		expect(systemsBefore).toBe(3);
		const systems = last.flatMap((m, i) => (m.role === "system" ? [{ m: m as System, i }] : []));
		const header = last.findIndex((m) => JSON.stringify(m).includes("[context window #"));
		expect(header).toBeGreaterThan(0);
		// One checkpoint at the head, holding the folded state of every system message before the cut.
		expect(systems).toHaveLength(2);
		expect(systems[0].i).toBe(0);
		expect(systems[0].m.toolsAdded?.map((t) => t.name).sort()).toEqual([...beforeCut].sort());
		// The system message written after the cut stays where it was, after the header.
		expect(systems[1].i).toBeGreaterThan(header);
		expect(systems[1].m.toolsAdded?.map((t) => t.name)).toEqual(["context_search"]);
		expect(systems[1].m.toolsRemoved).toBeUndefined();
	});
});
