/**
 * D8 (port): pin pointer, head and range lines name context_recall and context_search only while those
 * tools are active (hasTool, as the header does).
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, syntheticText, toolTurn, workExtension } from "./helpers.ts";

describe("D8: pointers and inactive tools", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function pinOf(active: "all" | "work only"): Promise<string> {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			// A cap of 1% of 32k forces every pass: pointers, ranges, and the current request's head.
			extensionFactories: [workExtension, createContextEngine({ stats, pinUserMessages: { capFraction: 0.01 } })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (active === "work only") harness.session.setActiveToolsByName(["work"]);
		let pin = "";
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, o) => {
			for (const msg of context.messages) {
				const c = msg.content as string | Array<{ type: string; text?: string }>;
				const text = typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n");
				const a = text.indexOf("<pinned-user-messages>");
				if (a >= 0) pin = text.slice(a, text.indexOf("</pinned-user-messages>", a));
			}
			return inner(m, context, o);
		};
		const model = scriptedModel(harness, 400);
		for (let i = 0; i < 12; i++) {
			model.push(finalTurn("Noted."));
			await harness.session.prompt(`Note ${i}: ${syntheticText(600, 40 + i).replace(/\s+/g, " ")}`);
		}
		for (let t = 0; t < 30; t++) model.push(toolTurn(4_000 + (t % 3) * 1_000, 2_000 + t));
		model.push(finalTurn("done"));
		await harness.session.prompt(`Final task: ${syntheticText(3_000, 99).replace(/\s+/g, " ")}`);
		expect(stats.cuts.length).toBeGreaterThan(0);
		return pin;
	}

	it("d8 pin pointers with the tools inactive name neither context_recall nor context_search", async () => {
		const inactive = await pinOf("work only");
		expect(inactive).toMatch(/\[user message \S+ \([^)]*\), \d+ chars, starts "/);
		expect(inactive).toMatch(/user message\(s\) \S+…\S+ \([^)]*\) not shown\]/);
		expect(inactive).not.toContain("context_recall");
		expect(inactive).not.toContain("context_search");
		// With the tools active, the same lines name them.
		const active = await pinOf("all");
		expect(active).toContain("; context_recall reads it]");
		expect(active).toContain("; context_search finds them]");
	});
});
