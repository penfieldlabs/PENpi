/**
 * notesAge (0.6.0 prototype, off by default): the header's working notes start with the UTC day they were
 * written and whether that was before the current request (D26's current request), so notes from an earlier
 * task are told apart from notes about this one. Off, the block is unchanged.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const MODEL = { id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 };

describe("notesAge: the working notes are dated against the current request", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(notesAge: boolean) {
		const stats = newStats();
		const harness = await createHarness({
			models: [MODEL],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, notesAge })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		installProviderSim(harness);
		// Every window header the provider sees, with the number of cuts made when it was sent.
		const headers: Array<{ cuts: number; text: string }> = [];
		const agent = harness.session.agent;
		const inner = agent.streamFunction;
		agent.streamFunction = (m, context, options) => {
			for (const msg of context.messages) {
				if (msg.role === "system") continue;
				const c = msg.content as string | Array<{ type: string; text?: string }>;
				const text = typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n");
				if (text.includes("[context window #")) headers.push({ cuts: stats.cuts.length, text });
			}
			return inner(m, context, options);
		};
		return { stats, harness, headers, model: scriptedModel(harness, 4_000) };
	}

	type H = Awaited<ReturnType<typeof setup>>;

	/** A run that writes `notes` first (if given), then works long enough to cut. */
	async function run(h: H, prompt: string, seed: number, notes?: string) {
		if (notes !== undefined)
			h.model.push(() =>
				fauxAssistantMessage([fauxToolCall("context_notes", { notes }, { id: `notes-${seed}` })], {
					stopReason: "toolUse",
				}),
			);
		for (let t = 0; t < 20; t++) h.model.push(toolTurn(6_000, seed + t));
		h.model.push(finalTurn(`done ${seed}`));
		const cuts = h.stats.cuts.length;
		await h.harness.session.prompt(prompt);
		expect(h.stats.cuts.length, `${prompt}: the run cut`).toBeGreaterThan(cuts);
	}

	/** The working-notes block of the last header sent. */
	const notesBlock = (h: H) => {
		const text = h.headers.at(-1)?.text ?? "";
		const a = text.indexOf("<working-notes>");
		const b = text.indexOf("</working-notes>");
		return a < 0 || b < 0 ? "" : text.slice(a, b + "</working-notes>".length);
	};

	const userId = (h: H, prompt: string) =>
		h.harness.sessionManager
			.getBranch()
			.find(
				(e) =>
					e.type === "message" &&
					e.message.role === "user" &&
					JSON.stringify(e.message.content).includes(prompt.slice(0, 20)),
			)?.id;

	const today = () => new Date().toISOString().slice(0, 10);

	it("notes from an earlier request are dated and marked as before the current one; notes written in it, as during it", async () => {
		const h = await setup(true);
		await run(h, "task one: process the first batch.", 0, "NOTES ONE: the first batch.");
		await run(h, "task two: process the second batch.", 100);
		const two = userId(h, "task two: process the second batch.");
		expect(two).toBeDefined();
		expect(notesBlock(h)).toBe(
			`<working-notes>\n[written ${today()}, before the current request (user message ${two}, sent ${today()}); may describe an earlier task]\nNOTES ONE: the first batch.\n</working-notes>`,
		);
		await run(h, "task three: process the third batch.", 200, "NOTES THREE: the third batch.");
		const three = userId(h, "task three: process the third batch.");
		expect(notesBlock(h)).toBe(
			`<working-notes>\n[written ${today()}, during the current request (user message ${three})]\nNOTES THREE: the third batch.\n</working-notes>`,
		);
	});

	it("off (the default): the working notes are sent as before, with no date line", async () => {
		const h = await setup(false);
		await run(h, "task one: process the first batch.", 0, "NOTES ONE: the first batch.");
		await run(h, "task two: process the second batch.", 100);
		expect(notesBlock(h)).toBe("<working-notes>\nNOTES ONE: the first batch.\n</working-notes>");
	});
});
