/**
 * Behaviours without a test, item 12: context_search on entries omitted by a context edit, on custom
 * messages and branch summaries, and when getActiveTools() throws. One case each.
 */

import type { Context as TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { finalTurn, scriptedModel } from "./helpers.ts";

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	if (last?.role !== "toolResult") return "";
	return last.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};

describe("context_search: entry kinds and inactive-tool lookups", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(engine: ExtensionFactory = createContextEngine({ stats: newStats() })) {
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [engine],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { harness, model: scriptedModel(harness) };
	}

	/** One prompt in which the model calls context_search with `args`; returns the tool result text. */
	async function search(h: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>): Promise<string> {
		let result = "";
		h.model.push(
			() =>
				fauxAssistantMessage([fauxToolCall("context_search", args as never, { id: "search-1" })], {
					stopReason: "toolUse",
				}),
			(context) => {
				result = lastToolText(context);
				return finalTurn("found")(context);
			},
		);
		await h.harness.session.prompt("Search for it.");
		return result;
	}

	it("b12 an entry omitted by a context edit is out of view: the default scope finds it", async () => {
		const h = await setup();
		h.model.push(finalTurn("noted"));
		await h.harness.session.prompt("Remember EDITMARK-77: the staging database is read-only on Fridays.");
		const user = h.harness.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user")!;
		h.harness.sessionManager.appendContextEdit(user.id, null);
		h.harness.session.refreshContext();
		const text = await search(h, { query: "editmark-77" });
		expect(text).toMatch(new RegExp(`- ${user.id} · turn \\d+ · user · out of view · `));
		expect(text).toContain("EDITMARK-77");
	});

	it("b12 a custom message is found, with its custom type as the role", async () => {
		const h = await setup();
		h.model.push(finalTurn("ok"));
		await h.harness.session.prompt("Start.");
		const id = h.harness.sessionManager.appendCustomMessageEntry(
			"penpi.note",
			"CUSTOMMARK-88 the deploy key rotates weekly",
			false,
		);
		h.harness.session.refreshContext();
		const text = await search(h, { query: "custommark-88 rotates", scope: "all" });
		expect(text).toMatch(new RegExp(`- ${id} · turn \\d+ · custom\\(penpi\\.note\\) · in view · CUSTOMMARK-88`));
	});

	it("b12 a branch summary is found", async () => {
		const h = await setup();
		h.model.push(finalTurn("ok"));
		await h.harness.session.prompt("Start.");
		const leaf = h.harness.sessionManager.getLeafId();
		const id = h.harness.sessionManager.branchWithSummary(
			leaf,
			"BRANCHMARK-99: the abandoned path tried a cache layer",
		);
		h.harness.session.refreshContext();
		const text = await search(h, { query: "branchmark-99 cache", scope: "all" });
		expect(text).toMatch(new RegExp(`- ${id} · turn \\d+ · branch summary · in view · BRANCHMARK-99`));
	});

	it("b12 getActiveTools() throwing: search still runs and the recovery tools count as active", async () => {
		// The engine sees an API whose getActiveTools throws (as on some hosts before tools are bound).
		const engine = createContextEngine({ stats: newStats() });
		const throwing: ExtensionFactory = (pi: ExtensionAPI) =>
			engine(
				new Proxy(pi, {
					get: (target, key, receiver) =>
						key === "getActiveTools"
							? () => {
									throw new Error("tools not bound");
								}
							: Reflect.get(target, key, receiver),
				}),
			);
		const h = await setup(throwing);
		h.model.push(finalTurn("noted"));
		await h.harness.session.prompt("THROWMARK-55: deploys need two approvals.");
		const text = await search(h, { query: "throwmark-55", scope: "all" });
		expect(text).toContain("THROWMARK-55");
		expect(text).toContain("context_recall");
	});
});
