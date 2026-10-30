import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { type AgentMessage, messageTokens, textOfContent } from "./estimator.ts";
import { HEADER_TYPE, NOTES_TOOL, RECALL_TOOL, SEARCH_TOOL, STATE_TYPE, TRANSCRIPT_SEARCH_TOOL } from "./options.ts";

export function installHeader(core: EngineCore): void {
	const { pi, opts, log, pinOpts, st } = core;

	// ---------------------------------------------------------------- header (E8, H5)
	/**
	 * H5 + D10: the pinned task is the prompt of the latest run, whatever its length (one "run" record per
	 * prompt); context_notes can replace it. "latest" records from older sessions still give the latest
	 * instruction, until the next run.
	 */
	function pinned(branch: SessionEntry[]): {
		task: string;
		notes: string;
		latest: string;
		explicit: boolean;
		noteTask: string;
	} {
		let task = "";
		let noteTask = "";
		let notes = "";
		let latest = "";
		let lastUser = "";
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as { kind?: string; prompt?: string };
				if (data.kind === "run" && data.prompt) {
					task = data.prompt;
					noteTask = "";
					latest = "";
				}
				if (data.kind === "latest" && data.prompt) latest = data.prompt;
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") lastUser = textOfContent(message.content).slice(0, opts.taskMaxChars);
			if (message.role === "toolResult" && message.toolName === NOTES_TOOL && !message.isError) {
				const details = message.details as { notes?: string; task?: string } | undefined;
				if (details?.notes !== undefined) notes = details.notes;
				if (details?.task) {
					task = details.task;
					noteTask = details.task;
				}
			}
		}
		return { task: task || lastUser, notes, latest, explicit: task !== "", noteTask };
	}

	/** Whether a tool is declared to the model (the header and notices name only those). */
	function hasTool(name: string): boolean {
		try {
			return pi.getActiveTools().includes(name);
		} catch {
			return name === NOTES_TOOL || name === RECALL_TOOL || name === SEARCH_TOOL;
		}
	}
	core.hasTool = hasTool;

	/** The header's guide to the recovery tools, naming only active ones. */
	function toolGuide(): string {
		const guideParts: string[] = [];
		if (hasTool(SEARCH_TOOL)) guideParts.push(`${SEARCH_TOOL} finds text in messages that left your context`);
		if (hasTool(RECALL_TOOL)) guideParts.push(`${RECALL_TOOL} reads any entry by id`);
		if (hasTool(TRANSCRIPT_SEARCH_TOOL)) guideParts.push(`${TRANSCRIPT_SEARCH_TOOL} searches earlier sessions`);
		let guide = guideParts.length > 0 ? ` ${guideParts.join("; ")}.` : "";
		if (hasTool(NOTES_TOOL))
			guide += ` Keep your plan and open threads in ${NOTES_TOOL}; they are carried into every window.`;
		return guide;
	}

	function makeHeader(seq: number, firstKeptEntryId: string, branch: SessionEntry[], withPin = true): string {
		const { task, notes, latest, noteTask } = pinned(branch);
		let omitted = 0;
		for (const entry of branch) {
			if (entry.id === firstKeptEntryId) break;
			if (entry.type === "message" && entry.message.role !== "system") omitted++;
			else if (entry.type === "custom_message") omitted++;
		}
		const lines = [
			`[context window #${seq}] The ${omitted} oldest messages of this session (everything before entry ${firstKeptEntryId}) are no longer in your context, to keep requests within the model's limit.`,
			`Nothing was summarized and nothing was deleted: the complete transcript is kept verbatim.${toolGuide()}`,
		];
		let report: ReturnType<typeof core.pinnedUserBlock>["report"] | undefined;
		if (pinOpts) {
			// The pin replaces the H5 task and latest instruction (both are user messages: carried when
			// they left the window, visible otherwise). A task the model set with context_notes stays pinned.
			if (noteTask) lines.push(`<pinned-task>\n${noteTask}\n</pinned-task>`);
			if (withPin) {
				const pinnedBlock = core.pinnedUserBlock(branch, firstKeptEntryId);
				report = pinnedBlock.report;
				if (pinnedBlock.block) lines.push(pinnedBlock.block);
			}
			// D26: the current request by name, pinned or still in the window. Without the pin (a size bound
			// before the cut is chosen) the line's longer form, since the cut decides which form it takes.
			const current = core.currentRequestLine(branch, firstKeptEntryId, !withPin);
			if (current) lines.push(current);
		} else {
			if (task) lines.push(`<pinned-task>\n${task}\n</pinned-task>`);
			if (latest) lines.push(`<latest-instruction>\n${latest}\n</latest-instruction>`);
		}
		if (notes) lines.push(`<working-notes>\n${notes}\n</working-notes>`);
		const header = lines.join("\n");
		if (report) {
			if (st.pinReports.size > 16) st.pinReports.clear();
			st.pinReports.set(header, report);
		}
		return header;
	}
	core.makeHeader = makeHeader;

	/**
	 * The header carries the cut's time (never serialized to the provider). Pi's estimateContextTokens
	 * (used by clampMaxTokensToContext for max_tokens) ignores the usage of assistant messages older than
	 * a newer prefix message; with timestamp 0 it trusted the pre-cut usage of the last kept assistant
	 * and squeezed max_tokens on the first request after a cut (3,931 on a 32k/8k model, reserve 6,553).
	 */
	function headerMessage(header: string, at = Date.now() + 1): AgentMessage {
		return {
			role: "custom",
			customType: HEADER_TYPE,
			content: header,
			display: false,
			timestamp: at,
		} as AgentMessage;
	}
	core.headerMessage = headerMessage;

	/**
	 * The header's size before the cut is chosen. Pin off: exact (a dummy cut; the header does not depend
	 * on the cut beyond its fixed-width numbers). Pin on: the header without the pin (with the
	 * longer form of the D26 current-request line) plus an upper bound on the pin for any cut (pinUpperTokens),
	 * so it never underestimates; chooseCut then measures the header at the chosen cut.
	 */
	function headerTokens(branch: SessionEntry[]): number {
		if (!pinOpts) return messageTokens(headerMessage(makeHeader(999, "xxxxxxxx", branch)));
		return messageTokens(headerMessage(makeHeader(999, "xxxxxxxx", branch, false))) + core.pinUpperTokens(branch);
	}
	core.headerTokens = headerTokens;

	// H5: remember the prompt that starts each run; the header pins it (D10: every prompt, short or long,
	// becomes the task; with the user-message pin on, the pin carries the earlier ones).
	pi.on("before_agent_start", (event) => {
		// D6: an image-only prompt starts a run too (it becomes the current request).
		if (!event.prompt && !event.images?.length) return;
		const prompt = event.prompt.slice(0, opts.taskMaxChars);
		// D10: one record kind for every run prompt (the pin treats short and long prompts alike). "latest"
		// records from older sessions are still read: they mark a run, and with the pin off they
		// are the latest instruction.
		const kind = "run";
		pi.appendEntry(STATE_TYPE, { kind, prompt });
		log(
			`run prompt (${kind}, ${event.prompt.trim().length} chars${event.images?.length ? `, ${event.images.length} image(s)` : ""})`,
		);
	});

	pi.on("session_before_tree", (event) => {
		if (!event.preparation.userWantsSummary) return undefined;
		return {
			summary: {
				summary:
					`The conversation came back from another branch (left at entry ${event.preparation.oldLeafId}). ` +
					"No summary was generated; the abandoned branch is kept verbatim in the transcript.",
			},
		};
	});
}
