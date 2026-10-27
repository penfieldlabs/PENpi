/**
 * D7 (port): source pairing never picks a stale input. An input another extension marks handled never
 * becomes a message, and it stayed pending until agent_settled; a later message whose text no input
 * matched (an extension transformed it) then paired with it and took its source, so an interactive
 * message recorded as "extension" dropped out of the pin. An idle input still pending at the next
 * idle input is dropped, and pairing tries an exact text match first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel } from "./helpers.ts";

describe("D7: input source pairing", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d7 an extension handles one input; the next interactive message is recorded as interactive", async () => {
		const stats = newStats();
		let api: ExtensionAPI | undefined;
		// Registered after the engine, so the engine sees every input first.
		const other = (pi: ExtensionAPI) => {
			api = pi;
			pi.on("input", (event) => {
				if (event.text.startsWith("!")) return { action: "handled" };
				if (event.source === "interactive")
					return { action: "transform", text: `Note from the team: ${event.text}` };
				return undefined;
			});
		};
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({ stats }), other],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const model = scriptedModel(harness, 20);
		await api!.sendUserMessage("!ping the status bar");
		model.push(finalTurn("Refactored."));
		await harness.session.prompt("Refactor the parser.", { source: "interactive" });

		const user = harness.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user");
		expect(user).toHaveLength(1);
		expect(stats.inputSources).toEqual({ interactive: 1 });
	});
});
