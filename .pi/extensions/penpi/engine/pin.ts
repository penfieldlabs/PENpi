import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { type AgentMessage, type Block, textOfContent, textTokens } from "./estimator.ts";
import { type PinSource, RECALL_TOOL, SEARCH_TOOL, STATE_TYPE } from "./options.ts";
import type { Carried, PinDecision } from "./state.ts";

export function installPin(core: EngineCore): void {
	const { pi, opts, stats, log, pinOpts, st } = core;

	/**
	 * The user-message pin. User messages that left the window (entries before firstKeptEntryId),
	 * oldest first, verbatim:
	 *   - only messages from pinned sources (Pi's InputSource recorded at the input event; interactive and
	 *     rpc by default); entries with no recorded source follow pin.unrecordedSource ("pin": carried);
	 *   - the current request (the prompt of the latest run) is always carried, whatever its source, and is
	 *     labelled; when longer than taskMaxChars it keeps its first taskMaxChars characters plus a pointer;
	 *   - messages starting with an agent prefix are labelled "from the manager agent, not typed by the
	 *     user", extension messages (when configured) "sent by an extension";
	 *   - over the cap (min(capFraction x window, capMaxTokens)), in order, stopping as soon as it fits:
	 *     middle messages (neither among the first protectFirst nor the current request) become pointers,
	 *     oldest first; then middle pointers collapse into range lines, oldest first; then the protected
	 *     first messages become pointers, newest first; then the current request becomes a pointer;
	 *   - a pointer carries the message's first 200 characters (whitespace collapsed).
	 * A message longer than longMessageChars (a paste) is always a pointer; an image block is an
	 * "[image: <mime>]" marker in place; a message with images and no text is an image line.
	 * D26: every marker (verbatim, pointer, range line) carries the UTC day the message was sent, and every
	 * carried message that is not the current request is labelled already handled, in each form. The header
	 * names the current request in a line of its own, pinned or still in the window, and says to stop and
	 * report once it is done.
	 */

	const PIN_INTRO =
		"Your user's earlier messages, oldest first, with the day each was sent (UTC). Their instructions and constraints still apply unless a later message changes them. A message marked already handled was a request that was done before this window: do not do its task again unless the current request asks you to.";
	/** D26: the label of every carried message that is not the current request, in every form. */
	const HANDLED =
		"earlier request, already handled: its rules still apply; do not do its task again unless the current request asks you to";
	const HANDLED_RANGE =
		"already handled: their rules still apply; do not do their tasks again unless the current request asks you to";
	/**
	 * The header changes only at a cut (prefix-cache stability), so a request the user sends after the cut
	 * is not reflected in the current-request line until the next cut: the sentence says when it was true.
	 */
	const CURRENT_SUPERSEDED =
		"It was the latest request when this window started and may still be in progress; a newer user message after this point supersedes it.";
	/** D26 (C4): the model must not take its next task from the pinned messages. */
	const CURRENT_DONE =
		"When the current request is done, stop and report; do not start requests from earlier messages.";
	const POINTER_CHARS = 200;
	/** D2: the prefix of the user messages PENpi 0.3.2-0.4.x injected (its length-continuation prompt). */
	const LEGACY_PENPI_PREFIX = "[PENpi] ";

	/** The prompt that started the latest run: the first user message after the latest run record. */
	function currentRequestId(branch: SessionEntry[]): string | undefined {
		let current: string | undefined;
		let armed = false;
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const kind = (entry.data as { kind?: string }).kind;
				if (kind === "run" || kind === "latest") armed = true;
				continue;
			}
			if (armed && entry.type === "message" && entry.message.role === "user") {
				current = entry.id;
				armed = false;
			}
		}
		return current;
	}

	/** D26 (C3): the UTC day of an entry (its timestamp, else its message's), or undefined. */
	function dayOf(entry: SessionEntry): string | undefined {
		const stamp = (entry as { timestamp?: unknown }).timestamp;
		const ms =
			typeof stamp === "string"
				? Date.parse(stamp)
				: typeof stamp === "number"
					? stamp
					: (entry as { message?: { timestamp?: unknown } }).message?.timestamp;
		if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
		return new Date(ms).toISOString().slice(0, 10);
	}

	function pinCarried(branch: SessionEntry[], firstKeptEntryId: string): Carried[] {
		const pin = pinOpts;
		if (!pin) return [];
		const currentId = currentRequestId(branch);
		const carried: Carried[] = [];
		for (const entry of branch) {
			if (entry.id === firstKeptEntryId) break;
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const source = st.sources.get((entry.message as { timestamp?: number }).timestamp ?? -1);
			const current = entry.id === currentId;
			if (!current && (source ? !pin.sources.includes(source) : pin.unrecordedSource !== "pin")) continue;
			const c = carriedOf(entry, current, source);
			if (c) carried.push(c);
		}
		return carried;
	}

	/** A user message as the pin carries it (undefined: nothing to carry). */
	function carriedOf(entry: SessionEntry, current: boolean, source: PinSource | undefined): Carried | undefined {
		const pin = pinOpts;
		if (!pin || entry.type !== "message" || entry.message.role !== "user") return undefined;
		const content = entry.message.content as unknown;
		const blocks: Block[] =
			typeof content === "string"
				? [{ type: "text", text: content }]
				: Array.isArray(content)
					? (content as Block[])
					: [];
		const images = blocks
			.filter((b) => b.type === "image")
			.map((b) => (b as { mimeType?: string }).mimeType ?? "unknown");
		const hasText = blocks.some((b) => b.type === "text" && (b.text ?? "").trim().length > 0);
		if (!hasText && images.length === 0) return undefined;
		const text = blocks
			.map((b) =>
				b.type === "text"
					? (b.text ?? "")
					: b.type === "image"
						? `[image: ${(b as { mimeType?: string }).mimeType ?? "unknown"}]`
						: "",
			)
			.filter((x) => x.length > 0)
			.join("\n")
			.trim();
		const recall = textOfContent(content);
		const mode = !hasText
			? "image"
			: current
				? recall.length > opts.taskMaxChars
					? "head"
					: "verbatim"
				: text.length > pin.longMessageChars
					? "pointer"
					: "verbatim";
		// D2: PENpi 0.3.2-0.4.x's own length-continuation prompt, in sessions from before sources were recorded.
		if (!source && text.startsWith(LEGACY_PENPI_PREFIX)) return undefined;
		const agent = pin.agentPrefixes.some((prefix) => prefix.length > 0 && text.startsWith(prefix));
		return { id: entry.id, text, recall, images, mode, current, source, agent, day: dayOf(entry) };
	}

	/** D26: the day it was sent first, then whether it is the current request or already handled. */
	function pinLabels(c: Carried): string[] {
		const labels: string[] = [];
		if (c.day) labels.push(`sent ${c.day}`);
		labels.push(c.current ? "current request" : HANDLED);
		if (c.agent) labels.push("from the manager agent, not typed by the user");
		if (c.source === "extension") labels.push("sent by an extension");
		return labels;
	}

	/** The first POINTER_CHARS characters, whitespace collapsed, with "…" when the text goes on. */
	function preview(c: Carried): string {
		return `${c.text.slice(0, POINTER_CHARS).replace(/\s+/g, " ").trim()}${POINTER_CHARS < c.text.length ? "…" : ""}`;
	}

	function imageOnly(c: Carried): boolean {
		return c.mode === "image" || (c.images.length > 0 && !c.text.replace(/\[image: [^\]]*\]/g, "").trim());
	}

	function imagesPhrase(c: Carried): string {
		return `${c.images.length === 1 ? "an image" : `${c.images.length} images`} (${[...new Set(c.images)].join(", ")}) and no text`;
	}

	function pinPointer(c: Carried): string {
		const tag = ` (${pinLabels(c).join("; ")})`;
		if (imageOnly(c)) return `[user message ${c.id}${tag}: ${imagesPhrase(c)}${recallHint(" reads it")}]`;
		return `[user message ${c.id}${tag}, ${c.recall.length} chars, starts "${preview(c)}"${recallHint(" reads it")}]`;
	}

	/** D8: pin pointers name context_recall only while it is active, as the header does. */
	function recallHint(rest: string): string {
		return core.hasTool(RECALL_TOOL) ? `; ${RECALL_TOOL}${rest}` : "";
	}

	function pinVerbatim(c: Carried): string {
		const line = `--- user message ${c.id} (${pinLabels(c).join("; ")}) ---`;
		if (c.mode !== "head") return `${line}\n${c.text}`;
		// D5: the head and the offset are taken from the text context_recall reads, so "offset" continues
		// exactly where the head stops; images are listed apart (they are not in that text).
		const head = opts.taskMaxChars;
		const images = c.images.map((mime) => `[image: ${mime}]\n`).join("");
		return `${line}\n${images}${c.recall.slice(0, head)}\n[characters ${head}-${c.recall.length} of ${c.recall.length} are not shown here${recallHint(`({ "entry": "${c.id}", "offset": ${head} }) reads the rest`)}]`;
	}

	/** A range holds only middle messages, never the current request: D26, they are all handled. */
	function rangeLine(count: number, from: string, to: string, firstDay?: string, lastDay?: string): string {
		const days = firstDay && lastDay ? (firstDay === lastDay ? firstDay : `${firstDay} to ${lastDay}`) : undefined;
		return `[${count} earlier user message(s) ${from}…${to} (${days ? `sent ${days}; ` : ""}${HANDLED_RANGE}) not shown${core.hasTool(SEARCH_TOOL) ? `; ${SEARCH_TOOL} finds them` : ""}]`;
	}

	function renderPin(carried: Carried[]): string {
		if (carried.length === 0) return "";
		const lines = ["<pinned-user-messages>", PIN_INTRO];
		for (let i = 0; i < carried.length; i++) {
			const c = carried[i];
			if (c.mode === "range") {
				let j = i;
				while (j + 1 < carried.length && carried[j + 1].mode === "range") j++;
				lines.push(rangeLine(j - i + 1, c.id, carried[j].id, c.day, carried[j].day));
				i = j;
			} else lines.push(c.mode === "verbatim" || c.mode === "head" ? pinVerbatim(c) : pinPointer(c));
		}
		lines.push("</pinned-user-messages>");
		return lines.join("\n");
	}

	/** min(capFraction x planning window, capMaxTokens). */
	function pinCap(): number {
		return pinOpts ? Math.min(Math.floor(pinOpts.capFraction * st.lastWindow), pinOpts.capMaxTokens) : 0;
	}
	core.pinCap = pinCap;

	/** Applies the cap passes to `carried` (mutating modes); returns the block and every pointering decision. */
	function capPin(carried: Carried[]): { block: string; decisions: PinDecision[]; cap: number } {
		const pin = pinOpts;
		const cap = pinCap();
		const pinDecisions: PinDecision[] = [];
		if (!pin || carried.length === 0) return { block: "", decisions: pinDecisions, cap };
		if (cap <= 0) return { block: renderPin(carried), decisions: pinDecisions, cap };
		// D9: the cap is in provider tokens; compare the calibrated estimate, as unit caps do (E4).
		const ratio = core.ratioFor(st.lastKey);
		const fits = () => textTokens(renderPin(carried)) * ratio <= cap;
		const set = (c: Carried, to: Carried["mode"], why: string) => {
			if (c.mode === to) return;
			pinDecisions.push({ id: c.id, from: c.mode, to, why });
			c.mode = to;
		};
		const notCurrent = carried.filter((c) => !c.current);
		const protectedSet = new Set(notCurrent.slice(0, pin.protectFirst));
		const middle = notCurrent.filter((c) => !protectedSet.has(c));
		for (const c of middle) {
			if (fits()) break;
			if (c.mode === "verbatim") set(c, "pointer", "middle, oldest first");
		}
		for (const c of middle) {
			if (fits()) break;
			set(c, "range", "middle pointers into a range, oldest first");
		}
		for (const c of [...protectedSet].reverse()) {
			if (fits()) break;
			if (c.mode === "verbatim") set(c, "pointer", `protected first ${pin.protectFirst}, newest first`);
		}
		for (const c of carried.filter((x) => x.current)) {
			if (fits()) break;
			if (c.mode === "verbatim" || c.mode === "head") set(c, "pointer", "current request, last");
		}
		return { block: renderPin(carried), decisions: pinDecisions, cap };
	}

	function pinnedUserBlock(
		branch: SessionEntry[],
		firstKeptEntryId: string,
	): { block: string; report: { tokens: number; cap: number; carried: number; decisions: PinDecision[] } } {
		const carried = pinCarried(branch, firstKeptEntryId);
		const { block, decisions: pinDecisions, cap } = capPin(carried);
		return {
			block,
			report: { tokens: block ? textTokens(block) : 0, cap, carried: carried.length, decisions: pinDecisions },
		};
	}
	core.pinnedUserBlock = pinnedUserBlock;

	/** Log the pin of a header that is being committed: its size and every pointering decision. */
	function logPin(header: string, seq: number): void {
		const report = st.pinReports.get(header);
		if (!report) return;
		stats.pinDecisions.push(...report.decisions.map((d) => ({ seq, ...d })));
		log(
			`pin #${seq}: ${report.carried} user message(s), ${report.tokens} tokens (cap ${report.cap})${report.decisions.length ? `; ${report.decisions.length} pointering decision(s)` : ""}`,
		);
		for (const d of report.decisions) log(`pin #${seq}: user message ${d.id} ${d.from} -> ${d.to} (${d.why})`);
	}
	core.logPin = logPin;

	/**
	 * An upper bound on the pinned block for any cut of this branch. The carried messages of a cut
	 * are a prefix P of all carried-eligible user messages U (the source filter and the current request do
	 * not depend on the cut). capPin(P) is at most cap once it fits, otherwise its smallest form; and it is
	 * never more than P rendered as it is, which is at most U rendered as it is. The smallest form of P is
	 * bounded by the intro lines, the pointer lines of U's first protectFirst + 1 messages, two range lines
	 * (the current request splits the middle at most once) with the widest count and ids, the longest
	 * pointer line of U (the current request's), and the closing tag.
	 */
	function pinUpperTokens(branch: SessionEntry[]): number {
		const pin = pinOpts;
		if (!pin) return 0;
		const all = pinCarried(branch, "\u0000none");
		if (all.length === 0) return 0;
		const asIs = textTokens(renderPin(all));
		const lines = all.map((c) => pinPointer(c));
		const longest = lines.reduce((a, b) => (textTokens(b) > textTokens(a) ? b : a), lines[0]);
		const protectedLines = lines.slice(0, Math.min(pin.protectFirst + 1, all.length));
		const widest = rangeLine(all.length, "99999999", "99999999", "9999-99-98", "9999-99-99");
		const smallest = textTokens(
			[
				"<pinned-user-messages>",
				PIN_INTRO,
				...protectedLines,
				widest,
				widest,
				longest,
				"</pinned-user-messages>",
			].join("\n"),
		);
		// +8: the block is joined into the header with a newline; the estimate of a concatenation may
		// differ from the sum of its parts by a token or two.
		// D9: capPin compares calibrated tokens with the cap, so in estimate units the cap is cap / ratio.
		return Math.min(asIs, Math.max(Math.floor(pinCap() / core.ratioFor(st.lastKey)), smallest)) + 8;
	}
	core.pinUpperTokens = pinUpperTokens;

	/**
	 * D26 (C2, C4): the header's current-request line for a cut at firstKeptEntryId. The current request is
	 * either carried by the pin (marked there) or still in the window (named here, with its first words, as a
	 * pointer does). No current request: "". `longest`: the longer of the two forms, for the header's size
	 * bound before the cut is chosen.
	 */
	function currentRequestLine(branch: SessionEntry[], firstKeptEntryId: string, longest = false): string {
		if (!pinOpts) return "";
		const currentId = currentRequestId(branch);
		if (!currentId) return "";
		let pinned = true;
		let entry: SessionEntry | undefined;
		for (const e of branch) {
			if (e.id === firstKeptEntryId) pinned = false;
			if (e.id === currentId) {
				entry = e;
				break;
			}
		}
		if (!entry || entry.type !== "message") return "";
		const c = carriedOf(entry, true, st.sources.get((entry.message as { timestamp?: number }).timestamp ?? -1));
		if (!c) return "";
		const tail = `${CURRENT_SUPERSEDED} ${CURRENT_DONE}`;
		const sent = c.day ? ` (sent ${c.day})` : "";
		const pinnedForm = `Current request: user message ${c.id}${sent}, marked current request in the pinned messages above. ${tail}`;
		const labels = pinLabels(c).filter((label) => label !== "current request");
		const what = imageOnly(c) ? `it is ${imagesPhrase(c)}` : `it starts "${preview(c)}"`;
		const windowForm = `Current request: user message ${c.id}${labels.length ? ` (${labels.join("; ")})` : ""}, in your context below; ${what}. ${tail}`;
		if (longest) return textTokens(windowForm) >= textTokens(pinnedForm) ? windowForm : pinnedForm;
		return pinned ? pinnedForm : windowForm;
	}
	core.currentRequestLine = currentRequestLine;

	// ---------------------------------------------------------------- input sources
	/**
	 * Pair a user message with the input event it came from: the oldest pending input whose text is the
	 * message's text or its start (Pi appends image hints), or that was a /template or /skill (expanded);
	 * else the oldest pending input (another extension transformed the text). None: the source stays
	 * unrecorded. The record is persisted, keyed by the message's timestamp.
	 */
	function recordSource(message: AgentMessage & { timestamp?: number }): void {
		if (st.pendingInputs.length === 0 || typeof message.timestamp !== "number") return;
		const text = textOfContent((message as { content?: unknown }).content);
		// D7: an exact match first, then a prefix (an expanded template), then a command, then the oldest.
		let at = st.pendingInputs.findIndex((p) => p.text.length > 0 && text === p.text);
		if (at < 0) at = st.pendingInputs.findIndex((p) => p.text.length > 0 && text.startsWith(p.text));
		if (at < 0) at = st.pendingInputs.findIndex((p) => p.text.startsWith("/"));
		if (at < 0) at = 0;
		const { source } = st.pendingInputs[at];
		st.pendingInputs = st.pendingInputs.filter((_, i) => i !== at);
		st.sources.set(message.timestamp, source);
		stats.inputSources[source] = (stats.inputSources[source] ?? 0) + 1;
		pi.appendEntry(STATE_TYPE, { kind: "source", at: message.timestamp, source });
	}
	core.recordSource = recordSource;

	/** Estimated tokens of the pinned block a request carries (0 when it carries none). */
	function requestPinTokens(messages: AgentMessage[]): number {
		if (!pinOpts) return 0;
		for (const m of messages.slice(0, 4)) {
			const raw = m as { content?: unknown; summary?: string };
			const text = typeof raw.summary === "string" ? raw.summary : textOfContent(raw.content);
			const a = text.indexOf("<pinned-user-messages>");
			if (a < 0) continue;
			const b = text.indexOf("</pinned-user-messages>", a);
			if (b < 0) continue;
			const block = text.slice(a, b + "</pinned-user-messages>".length);
			let size = st.pinSizes.get(block);
			if (size === undefined) {
				if (st.pinSizes.size > 16) st.pinSizes.clear();
				size = textTokens(block);
				st.pinSizes.set(block, size);
			}
			return size;
		}
		return 0;
	}
	core.requestPinTokens = requestPinTokens;
}
