import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "../core.ts";
import { type AgentMessage, textOfContent } from "../estimator.ts";
import { RECALL_TOOL, SEARCH_TOOL } from "../options.ts";
import { contributesMessages } from "../planner.ts";

/**
 * What a tool call contributes to its result's searchable text (D16): its argument values (the path it read,
 * the command it ran), not the tool name or the JSON keys, which every result of that tool would share.
 */
function callLabel(call: { name: string; arguments?: unknown }): string {
	const values: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			values.push(String(value));
		else if (Array.isArray(value)) for (const v of value) walk(v);
		else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v);
	};
	walk(call.arguments);
	return values.join(" ");
}

export function installSearch(core: EngineCore): void {
	const { pi, opts, st } = core;

	// R5: context_search. Case-insensitive search over the session's entries that are out of view (before
	// the current cut, omitted, or shown capped), or all entries; bounded output for context_recall.
	function searchEntries(
		ctx: ExtensionContext,
		query: string,
		scope: "out-of-view" | "all",
		limit: number,
	): { text: string; details: Record<string, unknown> } {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) throw new Error("Give at least one word to search for.");
		const branch = ctx.sessionManager.getBranch();
		// D16: a tool result does not contain what its call asked for (a read result holds the file, not its
		// path), so a result is searched together with its call, and a hit on a call names its result entry.
		// Later 8: calls and results pair in branch order (a result answers the earliest open call with its id), so
		// a provider that reuses ids pairs each result with its own call; empty ids pair nothing.
		const callOfResult = new Map<string, { label: string; entry: string }>();
		const resultOfBlock = new Map<string, string>();
		// N7: a queue per id, first in, first out: calls with the same id in one message pair in order. The queues
		// span one message (round 4): a message that opens calls drops the earlier calls that never got a result,
		// so an unanswered call does not take a later result with its id.
		const open = new Map<string, Array<{ label: string; entry: string; block: number }>>();
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = entry.message as AgentMessage & { toolCallId?: string };
			if (message.role === "assistant" && (message as AssistantMessage).content.some((b) => b.type === "toolCall"))
				open.clear();
			if (message.role === "assistant")
				(message as AssistantMessage).content.forEach((block, index) => {
					if (block.type === "toolCall" && block.id) {
						const queue = open.get(block.id) ?? [];
						queue.push({ label: callLabel(block), entry: entry.id, block: index });
						open.set(block.id, queue);
					}
				});
			if (message.role === "toolResult" && message.toolCallId) {
				const call = open.get(message.toolCallId)?.shift();
				if (!call) continue;
				callOfResult.set(entry.id, { label: call.label, entry: call.entry });
				resultOfBlock.set(`${call.entry}#${call.block}`, entry.id);
			}
		}
		const cut = core.readCut(branch);
		const keptFrom = cut ? branch.findIndex((e) => e.id === cut.firstKeptEntryId) : -1;
		const omitted = new Set(
			branch.flatMap((e) => (e.type === "context_edit" && e.replacement === null ? [e.targetId] : [])),
		);
		type Hit = {
			entry: string;
			role: string;
			turn: number;
			inView: boolean;
			capped: boolean;
			snippet: string;
			results: string[];
			found: number;
			/** F4: matched only through its call (none of its own text); the call's entry. */
			viaCall?: string;
		};
		const hits: Hit[] = [];
		let assistants = 0;
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i];
			if (!contributesMessages(entry)) continue;
			// A message the host never sends (hiddenCustomTypes: PENpi 0.4's briefing, Penfield memory) is not a
			// search result either: its text would come back as tool output outside the fence.
			if (entry.type === "custom_message" && opts.hiddenCustomTypes.includes(entry.customType)) continue;
			let role: string = entry.type === "custom_message" ? `custom(${entry.customType})` : "branch summary";
			let text = "";
			let results: string[] = [];
			let label = "";
			let callEntry: string | undefined;
			if (entry.type === "message") {
				const message = entry.message as AgentMessage & { toolName?: string; content?: unknown };
				if (message.role === "system") continue;
				if (message.role === "assistant") assistants++;
				// The engine's own lookups are copies of other entries (or the query itself): skip them.
				if (message.role === "toolResult" && (message.toolName === SEARCH_TOOL || message.toolName === RECALL_TOOL))
					continue;
				if (
					message.role === "assistant" &&
					(message as AssistantMessage).content.some((b) => b.type === "toolCall" && b.name === SEARCH_TOOL)
				)
					continue;
				role = message.role === "toolResult" ? `tool result ${message.toolName}` : message.role;
				// N8: an assistant's tool calls are searched by their argument values, as their results are, not
				// as name({json}), whose name and keys every call of a tool shares.
				text =
					message.role === "assistant"
						? (message as AssistantMessage).content
								.map((b) =>
									b.type === "toolCall"
										? callLabel(b)
										: b.type === "text"
											? b.text
											: b.type === "thinking"
												? b.thinking
												: "",
								)
								.join("\n")
						: textOfContent(message.content);
				const call = message.role === "toolResult" ? callOfResult.get(entry.id) : undefined;
				if (call) {
					label = call.label;
					callEntry = call.entry;
				}
				if (message.role === "assistant") {
					// F3: the results of the calls whose own text holds a query word; all of them when none does.
					const own = (message as AssistantMessage).content.flatMap((b, index) => {
						const result = b.type === "toolCall" ? resultOfBlock.get(`${entry.id}#${index}`) : undefined;
						return b.type === "toolCall" && result ? [{ result, label: callLabel(b).toLowerCase() }] : [];
					});
					// N5: most query words first (stable among equals).
					const hit = own
						.map((c) => ({ ...c, words: terms.filter((t) => c.label.includes(t)).length }))
						.filter((c) => c.words > 0)
						.sort((x, y) => y.words - x.words);
					results = (hit.length > 0 ? hit : own).map((c) => c.result);
				}
			} else if (entry.type === "custom_message") text = textOfContent(entry.content);
			else if (entry.type === "branch_summary") text = entry.summary ?? "";
			const turn =
				entry.type === "message" && entry.message.role === "user" ? assistants + 1 : Math.max(1, assistants);
			const capped = st.decisions.has(entry.id);
			const inView = !(cut && keptFrom >= 0 && i < keptFrom) && !omitted.has(entry.id);
			if (scope === "out-of-view" && inView && !capped) continue;
			// A result's call (D16) counts toward the words; the snippet comes from the entry's own text when it
			// has one of them, else from the call.
			const lower = text.toLowerCase();
			const withCall = label ? `${label.toLowerCase()}\n${lower}` : lower;
			const found = terms.filter((t) => withCall.includes(t)).length;
			if (found === 0) continue;
			const own = terms.find((t) => lower.includes(t));
			const source = own ? text : label;
			const at = (own ? lower : label.toLowerCase()).indexOf(
				own ?? (terms.find((t) => withCall.includes(t)) as string),
			);
			const from = Math.max(0, at - 80);
			const snippet = `${own ? "" : "call: "}${from > 0 ? "…" : ""}${source
				.slice(from, at + 120)
				.replace(/\s+/g, " ")
				.trim()}${at + 120 < source.length ? "…" : ""}`;
			hits.push({
				entry: entry.id,
				role,
				turn,
				inView,
				capped,
				snippet,
				results,
				found,
				...(own ? {} : { viaCall: callEntry ?? "" }),
			});
		}
		// F4: a result matched only through its call says nothing the call does not; recalling it returns none
		// of the words. Left out when its call is a hit (which names it); otherwise kept, its snippet marked
		// "call: ".
		const hitIds = new Set(hits.map((hit) => hit.entry));
		for (let k = hits.length - 1; k >= 0; k--)
			if (hits[k].viaCall && hitIds.has(hits[k].viaCall as string)) hits.splice(k, 1);
		hits.reverse();
		// Every word in one entry, as before. When no entry has them all, the entries with some of them, most
		// words first (newest first among equals), said so in the reply.
		const every = hits.filter((hit) => hit.found === terms.length);
		const partial = every.length === 0 && terms.length > 1;
		const matched = partial ? hits.slice().sort((a, b) => b.found - a.found) : every;
		const lines: string[] = [];
		let used = 0;
		const shown: Hit[] = [];
		for (const hit of matched) {
			if (shown.length >= limit) break;
			const where = hit.inView ? (hit.capped ? "in view, shown capped" : "in view") : "out of view";
			const result = hit.results.length ? ` · result: ${hit.results.join(", ")}` : "";
			const words = partial ? ` · ${hit.found} of ${terms.length} words` : "";
			const line = `- ${hit.entry} · turn ${hit.turn} · ${hit.role} · ${where}${result}${words} · ${hit.snippet}`;
			if (used + line.length > opts.searchMaxChars && shown.length > 0) break;
			const clipped = line.length > opts.searchMaxChars ? `${line.slice(0, opts.searchMaxChars - 1)}…` : line;
			lines.push(clipped);
			used += clipped.length;
			shown.push(hit);
		}
		const head =
			(partial
				? `[${SEARCH_TOOL} "${query}" (${scope}): no entry has every word; ${matched.length} ${matched.length === 1 ? "entry has" : "entries have"} some of them` +
					(matched.length > 0 ? `; ${shown.length} shown, most words first` : "")
				: `[${SEARCH_TOOL} "${query}" (${scope}): ${matched.length} ${matched.length === 1 ? "entry matches" : "entries match"}` +
					(matched.length > 0 ? `; ${shown.length} shown, newest first` : "")) +
			(matched.length > shown.length ? `; ${matched.length - shown.length} more not shown: narrow the query` : "") +
			(shown.length > 0 ? `. Read one with ${RECALL_TOOL}({ "entry": "<id>" }).]` : ".]");
		return {
			text: [head, ...lines].join("\n"),
			details: {
				query,
				scope,
				total: matched.length,
				...(partial ? { partial: true } : {}),
				shown: shown.map(({ snippet: _s, ...rest }) => rest),
			},
		};
	}

	pi.registerTool({
		name: SEARCH_TOOL,
		label: "Context search",
		description:
			"Search this session's transcript for text that is no longer in your context: messages that left the window, and the parts of long results that are not shown. Case-insensitive; every word must occur in the entry. Returns entry ids, roles, turn numbers and short snippets, newest first; read an entry in full with context_recall.",
		parameters: Type.Object({
			query: Type.String({
				description: "Words to find (case-insensitive; an entry matches when it contains all of them).",
			}),
			scope: Type.Optional(
				Type.String({
					description: '"out-of-view" (default): only what you cannot see now; "all": every entry.',
				}),
			),
			limit: Type.Optional(Type.Number({ description: "At most this many results." })),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const scope = params.scope === "all" ? "all" : "out-of-view";
			const limit = Math.max(1, Math.min(opts.searchMaxResults, Math.floor(params.limit ?? opts.searchMaxResults)));
			const { text, details } = searchEntries(ctx, params.query, scope, limit);
			return { content: [{ type: "text", text }], details };
		},
	});
}
