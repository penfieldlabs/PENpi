/**
 * D5 (port): a long current request with an image. The pin showed a head cut from text with "[image: …]"
 * markers and trimmed, while context_recall reads the message's raw text, so the pointer's offset and its
 * "of N" did not line up with what context_recall returns. The head, the offset and the length now come
 * from the text context_recall reads; images are listed apart.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel, syntheticText, toolTurn, workExtension } from "./helpers.ts";

const PNG = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
};
const POINTER = /context_recall\(\{ "entry": "([^"]+)", "offset": (\d+) \}\) reads the rest\]/;

describe("D5: the current request's head and offset", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d5 current request with an image and 3,000 characters: the pointer's offset reads exactly the rest", async () => {
		const stats = newStats();
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [workExtension, createContextEngine({ stats })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness, 400);
		const task = `Redesign task D5-START ${syntheticText(3_100, 5).replace(/\s+/g, " ")}`.slice(0, 3_000);
		let pin = "";
		let called = false;
		// Tool turns until the request carries the pin with the current request's pointer, then read the rest.
		const step = (n: number) => (context: Parameters<Parameters<typeof model.push>[0]>[0]) => {
			for (const message of context.messages) {
				const content = message.content as string | Array<{ type: string; text?: string }>;
				const text = typeof content === "string" ? content : content.map((b) => b.text ?? "").join("\n");
				if (POINTER.test(text)) pin = text;
			}
			const match = POINTER.exec(pin);
			if (match && !called) {
				called = true;
				return fauxAssistantMessage(
					[fauxToolCall("context_recall", { entry: match[1], offset: Number(match[2]) }, { id: "recall-1" })],
					{
						stopReason: "toolUse",
					},
				);
			}
			if (called) return finalTurn("done")(context);
			return toolTurn(5_000 + (n % 3) * 1_000, 700 + n)(context);
		};
		for (let n = 0; n < 60; n++) model.push(step(n));
		await harness.session.prompt(task, { images: [PNG] });

		expect(stats.cuts.length).toBeGreaterThan(0);
		const match = POINTER.exec(pin);
		expect(match).not.toBeNull();
		const offset = Number(match![2]);
		const entry = harness.sessionManager.getEntries().find((e) => e.id === match![1]);
		expect(entry?.type === "message" && entry.message.role === "user").toBe(true);
		// What context_recall reads: the message's text blocks (the image contributes an empty line).
		const recallText = `${task}\n`;
		// The head shown is exactly the first `offset` characters of that text, and "of N" is its length.
		expect(pin).toContain(
			`[image: image/png]\n${recallText.slice(0, offset)}\n[characters ${offset}-${recallText.length} of ${recallText.length} are not shown here;`,
		);
		const result = harness.sessionManager
			.getEntries()
			.find(
				(e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "context_recall",
			);
		const returned =
			result?.type === "message" && result.message.role === "toolResult"
				? ((result.message.content as Array<{ text?: string }>)[0].text ?? "")
				: "";
		expect(returned).toBe(
			`[entry ${match![1]} characters ${offset}-${recallText.length} of ${recallText.length}]\n${recallText.slice(offset)}`,
		);
		// Head plus the rest is the whole message.
		expect(recallText.slice(0, offset) + recallText.slice(offset)).toBe(recallText);
	});
});
