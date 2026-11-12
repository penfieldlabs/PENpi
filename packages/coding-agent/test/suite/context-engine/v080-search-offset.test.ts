/**
 * 0.8.0: context_search takes an offset. The reply showed at most `searchMaxResults` (10) hits and said how many more
 * matched, and `limit` could only lower that; nothing reached the rest. PENpi-bench's N facts ask for the first of six
 * runs whose replies echo the cue. In a PENpi-bench check, the first cue query hit the cap on 7 of 8 N facts, and
 * one fact took 16 searches. `offset` skips that many matches in the reply's order (newest first, or most words first),
 * and the "more not shown" line names the offset of the next page.
 */

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { scriptedModel } from "./helpers.ts";

const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	return last?.role === "toolResult" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

const ids = (reply: string) => [...reply.matchAll(/^- (\S+) · /gm)].map((m) => m[1]);

describe("0.8.0: context_search pages with offset", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** 14 bash results that each print the cue line, oldest first, then one context_search per argument set. */
	async function pages(searches: Array<Record<string, unknown>>) {
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createContextEngine({ stats: newStats() })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const results: string[] = [];
		for (let k = 0; k < 14; k++) {
			harness.sessionManager.appendMessage(
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: `node scripts/probe.mjs --run ${k + 1}` }, { id: `c${k}` })],
					{
						stopReason: "toolUse",
					},
				),
			);
			results.push(
				harness.sessionManager.appendMessage({
					role: "toolResult",
					toolCallId: `c${k}`,
					toolName: "bash",
					content: [{ type: "text", text: `watermark committed offset: ${1000 + k}` }],
					isError: false,
					timestamp: Date.now(),
				}),
			);
		}
		const model = scriptedModel(harness);
		const replies: string[] = [];
		for (const [k, args] of searches.entries())
			model.push((context) => {
				if (k > 0) replies.push(lastToolText(context));
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context_search",
							{ query: "watermark committed", scope: "all", ...args },
							{ id: `q${k}` },
						),
					],
					{ stopReason: "toolUse" },
				);
			});
		model.push((context) => {
			replies.push(lastToolText(context));
			return fauxAssistantMessage([fauxText("done")]);
		});
		await harness.session.prompt("Search.");
		// Newest first: the reply's order.
		return { replies, newestFirst: results.slice().reverse() };
	}

	it("the first page names the next offset, and the second page shows the rest", async () => {
		const { replies, newestFirst } = await pages([{}, { offset: 10 }]);
		const [first, second] = replies;
		expect(first).toMatch(
			/: 14 entries match; 10 shown, newest first; 4 more not shown: narrow the query, or pass offset 10 for the next ones\./,
		);
		expect(ids(first)).toEqual(newestFirst.slice(0, 10));
		expect(second).toMatch(/: 14 entries match; 4 shown \(matches 11 to 14\), newest first\. Read one with/);
		expect(second).not.toContain("more not shown");
		expect(ids(second)).toEqual(newestFirst.slice(10));
	});

	it("offset with limit, and an offset past the last match", async () => {
		const { replies, newestFirst } = await pages([{ offset: 2, limit: 3 }, { offset: 20 }]);
		const [middle, past] = replies;
		expect(middle).toMatch(
			/3 shown \(matches 3 to 5\), newest first; 9 more not shown: narrow the query, or pass offset 5 for/,
		);
		expect(ids(middle)).toEqual(newestFirst.slice(2, 5));
		expect(past).toMatch(/: 14 entries match; 0 shown \(offset 20 is past the last match\), newest first\.\]$/);
		expect(ids(past)).toEqual([]);
	});

	it("without offset the reply is as before, apart from the hint", async () => {
		const { replies } = await pages([{ limit: 14 }]);
		// limit can't raise the cap of 10.
		expect(replies[0]).toMatch(/10 shown, newest first; 4 more not shown/);
		expect(replies[0]).not.toContain("(matches");
	});
});
