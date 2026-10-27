/**
 * R5: context_search finds text in entries that left the window (case-insensitive, every word), with
 * entry ids, roles, turn numbers and snippets, bounded in count and characters, so the model can follow
 * up with context_recall. The header and notices name only tools that exist; searching and recalling
 * only append to the request, so the prefix still changes only at cuts.
 */
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL, type EngineOptions, NOTICE_MARKER, newStats } from "./engine.ts";
import { analyzePrefixes, finalTurn, report, scriptedModel, syntheticText, validateRequest } from "./helpers.ts";

/** `emit` returns "Report <tag>: " followed by synthetic text. */
function emitExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "emit",
		label: "emit",
		description: "Produce a report.",
		parameters: Type.Object({ tag: Type.String(), size: Type.Number(), seed: Type.Number() }),
		execute: async (_id, { tag, size, seed }) => ({
			content: [{ type: "text", text: `Report ${tag}: ${syntheticText(size, seed)}` }],
			details: {},
		}),
	});
}

const tag = (k: number) => `alpha-${String(k).padStart(3, "0")}`;
const lastToolText = (context: TranscriptContext): string => {
	const last = context.messages.at(-1);
	if (last?.role !== "toolResult") return "";
	return last.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};

/** Stands in for PENpi's search_transcript (which searches earlier session files). */
function transcriptSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search_transcript",
		label: "search_transcript",
		description: "Search earlier sessions.",
		parameters: Type.Object({ query: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "no results" }], details: {} }),
	});
}

async function session(engine: Partial<EngineOptions>, withTranscriptSearch = false) {
	const stats = newStats();
	const harness = await createHarness({
		models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			emitExtension,
			...(withTranscriptSearch ? [transcriptSearchExtension] : []),
			createContextEngine({ stats, ...engine }),
		],
	});
	await harness.session.bindExtensions({});
	const model = scriptedModel(harness);
	const results: Record<string, string> = {};
	const call = (name: string, args: Record<string, unknown>, id: string) => () =>
		fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
	for (let k = 0; k < 40; k++) model.push(call("emit", { tag: tag(k), size: 2_500, seed: k }, `emit-${k}`));
	model.push(call("context_search", { query: `REPORT ${tag(3)}` }, "search-1"));
	model.push((context) => {
		results.search1 = lastToolText(context);
		const id = /^- ([0-9a-f]{8}) ·/m.exec(results.search1)?.[1] ?? "missing";
		return call("context_recall", { entry: id, limit: 1_500 }, "recall-1")();
	});
	model.push((context) => {
		results.recall1 = lastToolText(context);
		return call("context_search", { query: "report" }, "search-2")();
	});
	model.push((context) => {
		results.search2 = lastToolText(context);
		return call("context_search", { query: `report ${tag(39)}`, scope: "all" }, "search-3")();
	});
	model.push((context) => {
		results.search3 = lastToolText(context);
		return finalTurn("done")(context);
	});
	await harness.session.prompt("Produce the reports, then look one up.");
	return { stats, harness, model, results };
}

describe("context_search", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("search finds an out-of-view entry, recall reads it, results are bounded, the prefix stays stable", async () => {
		const t = await session({});
		harnesses.push(t.harness);
		const branch = t.harness.sessionManager.getBranch();
		const assistants = branch.filter((e) => e.type === "message" && e.message.role === "assistant");
		const target = branch.find(
			(e) =>
				e.type === "message" &&
				e.message.role === "toolResult" &&
				JSON.stringify(e.message.content).includes(`Report ${tag(3)}:`),
		)!;
		// The emit call for alpha-003 is assistant turn 4; its result belongs to that turn.
		const callerTurn =
			assistants.findIndex((e) =>
				(e as { message: AssistantMessage }).message.content.some(
					(b) => b.type === "toolCall" && (b.arguments as { tag?: string }).tag === tag(3),
				),
			) + 1;
		const isNotice = (m: string) => NOTICE_MARKER !== undefined && m.includes(NOTICE_MARKER);
		const prefix = analyzePrefixes(t.model.requests, isNotice);
		const headers = t.model.requests.flatMap((r) => r.filter((m) => m.includes("[context window #")));
		const notices = t.model.requests.flatMap((r) => r.filter(isNotice));
		const search2Lines = t.results.search2.split("\n").filter((l) => l.startsWith("- "));
		report("r5", ENGINE_LABEL, "search", {
			cuts: t.stats.cuts.length,
			prefixBreaks: prefix.breaks,
			search1: t.results.search1,
			recall1: t.results.recall1.slice(0, 200),
			search2Head: t.results.search2.split("\n")[0],
			search2Chars: t.results.search2.length,
			search2Lines: search2Lines.length,
			search3: t.results.search3.split("\n").slice(0, 2),
			header: headers.at(-1)?.slice(0, 600),
			notice: notices[0],
		});
		expect(t.stats.cuts.length).toBeGreaterThan(0);
		// Found, out of view, with the right id, role and turn.
		expect(t.results.search1).toContain(`- ${target.id} · turn ${callerTurn} · tool result emit · out of view · `);
		expect(t.results.search1).toContain(`Report ${tag(3)}:`);
		expect(t.results.recall1).toContain(`Report ${tag(3)}:`);
		// Bounded: at most searchMaxResults lines and searchMaxChars characters (plus the one-line head).
		expect(t.results.search2).toMatch(/entries match; 10 shown, newest first; \d+ more not shown/);
		expect(search2Lines.length).toBe(10);
		expect(t.results.search2.length - t.results.search2.split("\n")[0].length).toBeLessThanOrEqual(4_001);
		// scope "all" also searches what is in view.
		expect(t.results.search3).toMatch(new RegExp(`· in view · Report ${tag(39)}:`));
		// Searching and recalling only append: the prefix changes only at cuts; requests stay valid.
		expect(prefix.breaks).toBe(t.stats.cuts.length);
		expect(t.model.requests.flatMap((r) => validateRequest(r))).toEqual([]);
		// The header and notices name only tools that exist.
		expect(headers.length).toBeGreaterThan(0);
		for (const text of [...headers, ...notices]) {
			expect(text).not.toContain("search_transcript");
			expect(text).not.toContain("memory");
		}
		expect(headers.at(-1)).toContain("context_search finds text in messages that left your context");
		expect(headers.at(-1)).toContain("context_recall reads any entry by id");
		expect(headers.at(-1)).toContain("context_notes");
	});

	it("the header names search_transcript only when that tool is active (PENpi)", async () => {
		const t = await session({}, true);
		harnesses.push(t.harness);
		const header = t.model.requests.flatMap((r) => r.filter((m) => m.includes("[context window #"))).at(-1) ?? "";
		report("r5", ENGINE_LABEL, "header-with-search-transcript", { header: header.slice(0, 500) });
		expect(header).toContain("search_transcript searches earlier sessions");
		expect(header).toContain("context_search finds text in messages that left your context");
	});

	it("search output respects a small character bound", async () => {
		const t = await session({ searchMaxChars: 600, searchMaxResults: 5 });
		harnesses.push(t.harness);
		const body = t.results.search2.split("\n").slice(1).join("\n");
		report("r5", ENGINE_LABEL, "search-small", { head: t.results.search2.split("\n")[0], chars: body.length });
		expect(body.length).toBeLessThanOrEqual(600 + 5);
		expect(t.results.search2.split("\n")[0]).toMatch(/entries match; [1-5] shown/);
	});
});
