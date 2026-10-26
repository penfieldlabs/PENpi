/**
 * D6 (port): an image-only prompt becomes the current request. before_agent_start returned early on an
 * empty prompt, so no run record was written and the previous prompt kept the "current request" label.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const PNG = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
};

describe("D6: image-only prompts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d6 an image-only prompt after a text prompt is labelled current request", async () => {
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats, log: (l) => lines.push(l) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const headers: string[] = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, o) => {
			for (const msg of context.messages) {
				const c = msg.content as string | Array<{ type: string; text?: string }>;
				const text = typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n");
				if (text.includes("<pinned-user-messages>")) headers.push(text);
			}
			return inner(m, context, o);
		};
		const model = scriptedModel(harness, 400);
		model.push(toolTurn(4_000, 1), finalTurn("Done with the text task."));
		await harness.session.prompt("Implement the login form described in the ticket.");
		// The image-only prompt's own run is long enough to cut, so its pin is built while it is current.
		for (let t = 0; t < 14; t++) model.push(toolTurn(5_000 + (t % 3) * 1_000, 100 + t));
		model.push(finalTurn("Matched the screenshot."));
		await harness.session.prompt("", { images: [PNG] });

		expect(stats.cuts.length).toBeGreaterThan(0);
		const pin = headers.at(-1) ?? "";
		expect(pin).toMatch(
			/\[user message \S+ \((?:sent \d{4}-\d\d-\d\d; )?current request\): an image \(image\/png\) and no text;/,
		);
		expect(pin).not.toMatch(
			/--- user message \S+ \((?:sent \d{4}-\d\d-\d\d; )?current request\) ---\nImplement the login form/,
		);
		expect(lines.some((l) => l.includes("run prompt (") && l.includes("0 chars, 1 image(s)"))).toBe(true);
	});
});
