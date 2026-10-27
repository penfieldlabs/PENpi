import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "./estimator.ts";

// ---------------------------------------------------------------- tool-call repair (RC6)

/**
 * A provider can stream a tool call with no id and no name (seen with GLM-5.3-Flash through OpenRouter). Pi
 * records it, answers it with "Tool  not found" under an empty tool_call_id, and the provider rejects every later
 * request with a 400. The engine repairs what it sends; the session file keeps the raw entries.
 */
export const NOTE_NO_NAME = "[a tool call with no name was removed from this request]";

export function noteNoId(name: string): string {
	return `[a call to ${name} with no id was removed from this request, with its result]`;
}

/** no-name: rule 1. no-id: rule 2, paired. no-id-unpaired: rule 2's fallback. orphan-result: rule 3. */
export type RepairKind = "no-name" | "no-id" | "no-id-unpaired" | "orphan-result";

const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";

/**
 * The id a call with a real name and no id gets: from the stored message's timestamp and the call's index among
 * its tool calls. The entry id is not reachable here (Pi hands the handler a structured clone of the messages),
 * and the timestamp is as stable: it is stored with the message, so every request built from the session gives
 * the same id. Two assistant messages of one branch share a timestamp only if two responses ended in the same
 * millisecond; an id already used in the request is never given twice (that call falls back to the note).
 */
export function repairedId(message: AssistantMessage, callIndex: number): string {
	return `penpi_${message.timestamp ?? 0}_${callIndex}`;
}

/**
 * The messages with every tool call that has no name or no id repaired. Pure: the output depends only on
 * `messages`, which are not changed, and the same array comes back when nothing needs a repair. A message's
 * results are the run of tool results right after it (Pi records them there, sequential and parallel); a system
 * message inside that run is skipped, as Pi's transformMessages does. As in
 * D16, calls with an empty id pair with results with an empty id first in, first out: the k-th with the k-th.
 * - Rule 1, no name (with or without an id): nothing ran. The calls become one note; their results are dropped.
 * - Rule 2, a real name and no id: the tool ran. The call and its paired result get the same id (`repairedId`).
 *   On a name mismatch, no result to pair, or an id already used, the call becomes a note and its result is dropped.
 * - Rule 3: any result left with an empty id is dropped.
 */
export function repairToolCalls(messages: AgentMessage[]): { messages: AgentMessage[]; kinds: RepairKind[] } {
	let out: AgentMessage[] | undefined;
	const set = (index: number, message: AgentMessage) => {
		out ??= messages.slice();
		out[index] = message;
	};
	const drop = new Set<number>();
	const kinds = new Set<RepairKind>();
	let used: Set<string> | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "toolResult") {
			// Rule 3 (a result rule 2 gave an id is read from `out`; one rule 1 or 2 dropped is not counted again).
			if (!drop.has(i) && blank(((out?.[i] ?? message) as ToolResultMessage).toolCallId)) {
				drop.add(i);
				kinds.add("orphan-result");
			}
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const assistant = message as AssistantMessage;
		if (!assistant.content.some((b) => b.type === "toolCall" && (blank(b.name) || blank(b.id)))) continue;
		// Every id the request already carries, so a repaired id never repeats one (built once, on the first repair).
		used ??= new Set(
			messages.flatMap((m) =>
				m.role === "assistant" && Array.isArray(m.content)
					? (m as AssistantMessage).content.flatMap((b) => (b.type === "toolCall" && !blank(b.id) ? [b.id] : []))
					: [],
			),
		);
		// This message's results: those with an empty id in order (the FIFO queue), and the others with an id. A
		// system message among them is skipped, as Pi's transformMessages holds it back until the results are in.
		const emptyIdResults: number[] = [];
		const withId: number[] = [];
		for (let j = i + 1; j < messages.length; j++) {
			if (messages[j].role === "system") continue;
			if (messages[j].role !== "toolResult") break;
			(blank((messages[j] as ToolResultMessage).toolCallId) ? emptyIdResults : withId).push(j);
		}
		const content: AssistantMessage["content"] = [];
		let noted = false;
		let callIndex = 0;
		for (const block of assistant.content) {
			if (block.type !== "toolCall") {
				content.push(block);
				continue;
			}
			const call: ToolCall = block;
			const index = callIndex++;
			const at = blank(call.id) ? emptyIdResults.shift() : undefined;
			if (blank(call.name)) {
				if (!noted) content.push({ type: "text", text: NOTE_NO_NAME });
				noted = true;
				// With an id, its result is the first with that id and no name (or the call's own): a valid call that
				// repeats the id keeps its result.
				const own =
					at ??
					withId.find((j) => {
						const r = messages[j] as ToolResultMessage;
						return r.toolCallId === call.id && (blank(r.toolName) || r.toolName === call.name) && !drop.has(j);
					});
				if (own !== undefined) drop.add(own);
				kinds.add("no-name");
				continue;
			}
			if (blank(call.id)) {
				const result = at === undefined ? undefined : (messages[at] as ToolResultMessage);
				const id = repairedId(assistant, index);
				if (result && result.toolName === call.name && !used.has(id)) {
					used.add(id);
					content.push({ ...call, id });
					set(at!, { ...result, toolCallId: id } as AgentMessage);
					kinds.add("no-id");
				} else {
					content.push({ type: "text", text: noteNoId(call.name) });
					if (at !== undefined) drop.add(at);
					kinds.add("no-id-unpaired");
				}
				continue;
			}
			content.push(call);
		}
		set(i, { ...assistant, content } as AgentMessage);
	}
	if (!out && drop.size === 0) return { messages, kinds: [] };
	const base = out ?? messages;
	return { messages: base.filter((_, index) => !drop.has(index)), kinds: [...kinds] };
}
