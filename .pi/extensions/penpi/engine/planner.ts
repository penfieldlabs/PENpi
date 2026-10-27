import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import {
	type AgentMessage,
	imageSize,
	imageTokens,
	messageImageTokens,
	messageTokens,
	requestShape,
	textTokens,
} from "./estimator.ts";
import {
	HEADER_FORMAT,
	NOTES_TOOL,
	NOTICE_MARKER,
	NOTICE_TYPE,
	RECALL_TOOL,
	SEARCH_TOOL,
	STATE_TYPE,
	systemPromptSection,
} from "./options.ts";
import { repairToolCalls } from "./repair.ts";
import type { Item, Limits, SectionMap, WindowIndex } from "./state.ts";

export function isStartable(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "custom":
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant": {
			const stop = (message as AssistantMessage).stopReason;
			return stop !== "error" && stop !== "aborted";
		}
		default:
			return false;
	}
}

// ================================================================== unit caps (E4, H6)

/** A frozen cap decision for one session entry: keep `chars` of its text, replace these images. */
export interface CapDecision {
	chars?: number;
	dropImages?: number[];
	/** b modes: the cap was written into the session as a context_edit; do not apply it again. */
	materialized?: boolean;
}

export function cappable(message: AgentMessage): boolean {
	if (message.role === "custom") return !message.customType.startsWith(STATE_TYPE);
	return message.role === "toolResult" || message.role === "user";
}

export function contentBlocks(message: AgentMessage): Array<TextContent | ImageContent> {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Array<TextContent | ImageContent>) : [];
}

/** Decide a cap for a unit over `maxUnit` provider tokens; text and images share the unit budget. */
export function decideCap(message: AgentMessage, maxUnit: number, ratio: number): CapDecision | undefined {
	if (!cappable(message)) return undefined;
	const blocks = contentBlocks(message);
	const text = blocks
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const textCost = textTokens(text) * ratio;
	const images = blocks.flatMap((b, index) => (b.type === "image" ? [{ index, cost: imageTokens(b) * ratio }] : []));
	const imageCost = images.reduce((sum, image) => sum + image.cost, 0);
	if (textCost + imageCost <= maxUnit) return undefined;
	const decision: CapDecision = {};
	const textBudget = images.length > 0 ? Math.max(maxUnit * 0.5, maxUnit - imageCost) : maxUnit;
	let textUsed = textCost;
	if (textCost > textBudget) {
		decision.chars = Math.max(1_000, Math.floor((text.length * textBudget) / textCost));
		textUsed = textBudget;
	}
	let room = maxUnit - textUsed;
	const drop: number[] = [];
	for (const image of [...images].reverse()) {
		if (image.cost <= room) room -= image.cost;
		else drop.push(image.index);
	}
	if (drop.length > 0) decision.dropImages = drop.sort((a, b) => a - b);
	return decision.chars !== undefined || decision.dropImages ? decision : undefined;
}

/** Render a capped copy of `message` (head/tail text and image placeholders, all pointing at the entry). */
export function applyCap(message: AgentMessage, entryId: string, decision: CapDecision): AgentMessage {
	const blocks = contentBlocks(message);
	const imageCount = blocks.filter((b) => b.type === "image").length;
	const out: Array<TextContent | ImageContent> = [];
	let textDone = false;
	let imageNumber = 0;
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (block.type === "text") {
			if (decision.chars === undefined) {
				out.push(block);
				continue;
			}
			if (textDone) continue;
			textDone = true;
			const text = blocks
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			const head = Math.floor(decision.chars * 0.75);
			const tail = decision.chars - head;
			const marker =
				`\n\n[context-engine: characters ${head}-${text.length - tail} of ${text.length} are not shown here. ` +
				`The full content is kept verbatim in session entry ${entryId}; read it with ` +
				`${RECALL_TOOL}({ "entry": "${entryId}", "offset": ${head} }).]\n\n`;
			out.push({ type: "text", text: text.slice(0, head) + marker + text.slice(text.length - tail) });
			continue;
		}
		imageNumber++;
		if (decision.dropImages?.includes(index)) {
			const size = imageSize(block.data);
			out.push({
				type: "text",
				text:
					`[image ${imageNumber} of ${imageCount}${size ? ` (${size.width}x${size.height})` : ""} is not shown here to keep the request within the model's limit; ` +
					`it is kept in session entry ${entryId}: ${RECALL_TOOL}({ "entry": "${entryId}", "image": ${index} })]`,
			});
		} else out.push(block);
	}
	return { ...message, content: out } as AgentMessage;
}

export function contributesMessages(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/** The context messages one entry contributes (mirrors Pi's sessionEntryToContextMessages for non-compaction entries). */
export function entryMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") return entry.message ? [entry.message as AgentMessage] : [];
	if (entry.type === "custom_message") {
		return [
			{
				role: "custom",
				customType: entry.customType,
				content: entry.content ?? [],
				display: entry.display,
				details: entry.details,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [
			{
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		];
	}
	return [];
}

export function installPlanner(core: EngineCore): void {
	const { pi, opts, stats, log, pinOpts, st } = core;

	// ---------------------------------------------------------------- system sections at a cut (E8.14)
	/**
	 * A host changes a system prompt section only at a cut (EngineHandle.setSectionAtNextCut), so the prompt,
	 * and the provider's cache, change only where the window does. The override is part of the cut: the
	 * checkpoint carries it, older copies of the section in the window are removed, and the cut entry records
	 * it (with the overrides already in effect this session), so a rebuilt window sends the same prompt. A
	 * system message newer than the override (the host setting the section at a new session) wins.
	 */
	core.sectionsAtCut = (take) => {
		const pending = Object.entries(st.pendingSections).filter(([name, text]) => st.appliedSections[name] !== text);
		if (take) st.pendingSections = {};
		if (pending.length === 0)
			return Object.keys(st.appliedSections).length > 0 ? { ...st.appliedSections } : undefined;
		const sections = { ...st.appliedSections, ...Object.fromEntries(pending) };
		if (take) {
			st.appliedSections = sections;
			for (const [name] of pending) st.appliedAt[name] = Date.now();
			log(`system prompt sections changed at the cut: ${pending.map(([name]) => name).join(", ")}`);
		}
		return sections;
	};
	core.pruneApplied = (branch) => {
		for (const name of Object.keys(st.appliedSections)) {
			const since = st.appliedAt[name] ?? 0;
			const superseded = branch.some((entry) => {
				if (entry.type !== "message" || entry.message.role !== "system") return false;
				const sections = (entry.message as { sections?: Record<string, string | null> }).sections;
				return timeOf(entry.message as AgentMessage) > since && sections !== undefined && name in sections;
			});
			if (superseded) {
				delete st.appliedSections[name];
				delete st.appliedAt[name];
				log(`system prompt section ${name}: a newer system message sets it; the cut's change no longer applies`);
			}
		}
	};
	const timeOf = (message: AgentMessage) => (message as { timestamp?: number }).timestamp ?? 0;
	core.systemWith = (systems, override) => {
		if (!override?.sections) return getCurrentSystemMessage(systems as never) as AgentMessage | undefined;
		const at = override.at ?? Number.POSITIVE_INFINITY;
		const delta = { role: "system", content: "", sections: override.sections, timestamp: at } as AgentMessage;
		const older = systems.filter((m) => timeOf(m) < at);
		const newer = systems.filter((m) => timeOf(m) >= at);
		const merged = getCurrentSystemMessage([...older, delta, ...newer] as never) as AgentMessage | undefined;
		// The checkpoint keeps the first system message's time (Pi's estimate reads it), as without an override.
		return merged && older[0] ? ({ ...merged, timestamp: timeOf(older[0]) } as AgentMessage) : merged;
	};
	core.stripOverridden = (items, override) => {
		if (!override?.sections) return;
		const at = override.at ?? Number.POSITIVE_INFINITY;
		const names = Object.keys(override.sections);
		for (const item of items) {
			if (!item.system || timeOf(item.message) >= at) continue;
			const sections = (item.message as { sections?: Record<string, string | null> }).sections;
			if (!sections || !names.some((name) => name in sections)) continue;
			const kept = Object.fromEntries(Object.entries(sections).filter(([name]) => !names.includes(name)));
			item.out = { ...item.message, sections: kept } as AgentMessage;
			item.tokens = core.sendTokens(item.out);
		}
	};

	/**
	 * Choose a cut with the header measured at the cut. Pin off: one choice with headerTokens (header left
	 * to the caller). Pin on, deterministic, at most one extra pass:
	 *   1. choose with the upper bound (base + headerTokens) and render the header at that cut;
	 *   2. if the exact header is smaller, choose once more with it; keep that cut only if its own exact
	 *      header is no larger than the size it was chosen with, else keep the first cut.
	 * The returned fixedAfter is never less than base + the returned header's size, so a request never
	 * exceeds its budget because of the estimate.
	 */
	function chooseCut(
		branch: SessionEntry[],
		seq: number,
		base: number,
		choose: (fixedAfter: number) => number,
		entryAt: (start: number) => string | undefined,
	): { start: number; fixedAfter: number; header?: string } {
		const upper = base + core.headerTokens(branch);
		const first = choose(upper);
		if (!pinOpts) return { start: first, fixedAfter: upper };
		const firstId = entryAt(first);
		if (firstId === undefined) return { start: first, fixedAfter: upper };
		const header1 = core.makeHeader(seq, firstId, branch);
		const exact1 = base + messageTokens(core.headerMessage(header1));
		const plan = (start: number, fixedAfter: number, header: string, secondPass: boolean) => {
			stats.headerPlans.push({
				upper: upper - base,
				planned: fixedAfter - base,
				rendered: messageTokens(core.headerMessage(header)),
				secondPass,
			});
			return { start, fixedAfter, header };
		};
		if (exact1 > upper) {
			// The bound is proven above; this is a guard, not a path: keep the larger number.
			stats.headerBoundMisses++;
			log(`header bound miss: exact ${exact1} > upper ${upper} at cut ${firstId}`);
			return plan(first, exact1, header1, false);
		}
		if (exact1 === upper) return plan(first, exact1, header1, false);
		const second = choose(exact1);
		const secondId = second === first ? undefined : entryAt(second);
		if (secondId === undefined) return plan(first, exact1, header1, false);
		const header2 = core.makeHeader(seq, secondId, branch);
		const exact2 = base + messageTokens(core.headerMessage(header2));
		if (exact2 <= exact1) return plan(second, exact2, header2, true);
		return plan(first, exact1, header1, false);
	}
	core.chooseCut = chooseCut;

	// ---------------------------------------------------------------- items and caps
	function itemFor(entryId: string, message: AgentMessage, limits: Limits, ratio: number): Item {
		if (message.role === "system")
			return { entryId, message, out: message, tokens: core.sendTokens(message), startable: false, system: true };
		let decision = st.decisions.get(entryId);
		if (!decision && cappable(message)) {
			decision = decideCap(message, core.maxUnitTokens(limits), ratio);
			if (decision) {
				st.decisions.set(entryId, decision);
				st.pendingDecisions[entryId] = decision;
				stats.capDecisions++;
			}
		}
		let out: AgentMessage = message;
		if (decision && !decision.materialized) {
			const cached = st.outCache.get(entryId);
			if (cached && cached.message === message) out = cached.out;
			else {
				out = applyCap(message, entryId, decision);
				st.outCache.set(entryId, { message, out });
			}
		}
		return { entryId, message, out, tokens: core.sendTokens(out), startable: isStartable(message), system: false };
	}

	function flushDecisions(): void {
		if (Object.keys(st.pendingDecisions).length === 0) return;
		pi.appendEntry(STATE_TYPE, { kind: "caps", decisions: st.pendingDecisions });
		st.pendingDecisions = {};
	}

	function suffixSums(items: Array<{ tokens: number }>): number[] {
		const sums = new Array<number>(items.length + 1).fill(0);
		for (let i = items.length - 1; i >= 0; i--) sums[i] = sums[i + 1] + items[i].tokens;
		return sums;
	}
	core.suffixSums = suffixSums;

	/** Smallest startable index > from (or >= from) whose window fits `target` provider tokens. */
	function chooseStart(
		items: Item[],
		from: number,
		fixedTokens: number,
		targetTokens: number,
		ratio: number,
		strictlyAfter = false,
	): number {
		const sums = suffixSums(items);
		let lastStartable = -1;
		for (let s = strictlyAfter ? from + 1 : from; s < items.length; s++) {
			if (!items[s].startable) continue;
			if (s > 0 && items[s - 1].entryId === items[s].entryId) continue;
			lastStartable = s;
			if ((fixedTokens + sums[s]) * ratio <= targetTokens) return s;
		}
		return lastStartable >= 0 ? lastStartable : from;
	}
	core.chooseStart = chooseStart;

	// ---------------------------------------------------------------- mode a: incremental index (H7)
	/** A message the host never sends (hiddenCustomTypes): out of the index and of every request. */
	const hidden = (message: AgentMessage) =>
		message.role === "custom" && opts.hiddenCustomTypes.includes((message as { customType: string }).customType);

	function rebuildIndex(ctx: ExtensionContext, limits: Limits, ratio: number): WindowIndex {
		stats.indexRebuilds++;
		const branch = ctx.sessionManager.getBranch();
		const cut = core.readCut(branch);
		const projection = ctx.sessionManager.buildSessionProjection();
		const all: Item[] = [];
		for (const projected of projection.entries) {
			for (const message of projected.messages)
				if (!hidden(message)) all.push(itemFor(projected.sourceEntry.id, message, limits, ratio));
		}
		let start = 0;
		if (cut) {
			start = all.findIndex((item) => item.entryId === cut.firstKeptEntryId);
			if (start < 0) {
				// The cut entry is not projected any more (omitted, or another branch): keep what follows it.
				const order = new Map(branch.map((e, i) => [e.id, i]));
				const at = order.get(cut.firstKeptEntryId);
				start =
					at === undefined
						? 0
						: Math.max(
								0,
								all.findIndex((item) => (order.get(item.entryId) ?? -1) >= at && item.startable),
							);
			}
		}
		const items = all.slice(start);
		if (start > 0) core.stripOverridden(items, cut);
		const checkpoint =
			start > 0
				? core.systemWith(
						all
							.slice(0, start)
							.filter((i) => i.system)
							.map((i) => i.message),
						cut,
					)
				: undefined;
		const header = start > 0 && cut ? core.headerMessage(cut.header, cut.at) : undefined;
		return {
			leafId: ctx.sessionManager.getLeafId(),
			items,
			total: items.reduce((sum, item) => sum + item.tokens, 0),
			cut: start > 0 ? cut : undefined,
			checkpoint,
			checkpointTokens: checkpoint ? messageTokens(checkpoint) : 0,
			header,
			headerTokens: header ? messageTokens(header) : 0,
			recent: [],
			targetKey: st.targetKey,
		};
	}

	/** Bring the index up to the current leaf by walking only the new entries. */
	function updateIndex(ctx: ExtensionContext, limits: Limits, ratio: number): WindowIndex {
		const rebuild = () => {
			st.index = rebuildIndex(ctx, limits, ratio);
			return st.index;
		};
		if (!st.index || st.index.targetKey !== st.targetKey) return rebuild();
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf === st.index.leafId) return st.index;
		const fresh: SessionEntry[] = [];
		let id: string | null = leaf;
		while (id && id !== st.index.leafId && fresh.length < 10_000) {
			const entry = ctx.sessionManager.getEntry(id);
			if (!entry) break;
			fresh.push(entry);
			id = entry.parentId;
		}
		if (id !== st.index.leafId) return rebuild();
		for (const entry of fresh.reverse()) {
			if (entry.type === "compaction") return rebuild();
			if (entry.type === "context_edit") {
				const at = st.index.items.findIndex((item) => item.entryId === entry.targetId);
				if (at < 0) continue;
				if (entry.replacement !== null) return rebuild();
				st.index.total -= st.index.items[at].tokens;
				st.index.items.splice(at, 1);
				continue;
			}
			for (const message of entryMessages(entry)) {
				if (hidden(message)) continue;
				const item = itemFor(entry.id, message, limits, ratio);
				st.index.items.push(item);
				st.index.total += item.tokens;
			}
		}
		st.index.leafId = leaf;
		return st.index;
	}

	function aligned(idx: WindowIndex, messages: AgentMessage[]): boolean {
		const before = messages.length - idx.items.length;
		if (before < 0) return false;
		for (let i = 0; i < idx.items.length; i++)
			if (idx.items[i].message.role !== messages[before + i].role) return false;
		return true;
	}

	/** H6: after a cut, keep the newest images within imageShare of the budget; replace older ones. Frozen. */
	function evictImages(idx: WindowIndex, limits: Limits, ratio: number): void {
		let room = (opts.imageShare * limits.budget) / ratio;
		for (let i = idx.items.length - 1; i >= 0; i--) {
			const item = idx.items[i];
			if (!cappable(item.message)) continue;
			const blocks = contentBlocks(item.message);
			const decision = { ...(st.decisions.get(item.entryId) ?? {}) };
			const dropped = new Set(decision.dropImages ?? []);
			let changed = false;
			for (let k = blocks.length - 1; k >= 0; k--) {
				const block = blocks[k];
				if (block.type !== "image" || dropped.has(k)) continue;
				const cost = imageTokens(block);
				if (cost <= room) room -= cost;
				else {
					dropped.add(k);
					changed = true;
					stats.imageEvictions++;
				}
			}
			if (!changed) continue;
			decision.dropImages = [...dropped].sort((a, b) => a - b);
			st.decisions.set(item.entryId, decision);
			st.pendingDecisions[item.entryId] = decision;
			st.outCache.delete(item.entryId);
			const replaced = itemFor(item.entryId, item.message, limits, ratio);
			idx.total += replaced.tokens - item.tokens;
			idx.items[i] = replaced;
		}
	}

	/** One line naming what the next cut would remove. */
	function noticeFor(items: Item[], next: number, tokensUntilCut: number): AgentMessage {
		const leaving = items.slice(0, next);
		const tools = new Map<string, number>();
		const files = new Set<string>();
		for (const item of leaving) {
			if (item.message.role !== "assistant") continue;
			for (const block of (item.message as AssistantMessage).content) {
				if (block.type !== "toolCall" || !block.name.trim()) continue;
				tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
				const args = (block.arguments ?? {}) as Record<string, unknown>;
				for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
					if (typeof args[key] === "string") files.add(args[key] as string);
				}
			}
		}
		const toolList = [...tools.entries()].map(([name, count]) => `${name}x${count}`).join(", ");
		const fileList = [...files].slice(0, 8).join(", ") + (files.size > 8 ? ` +${files.size - 8} more` : "");
		const text =
			`${NOTICE_MARKER} In about ${Math.max(0, Math.round(tokensUntilCut))} tokens the next cut removes ${leaving.length} messages from your view ` +
			`(entries ${leaving[0]?.entryId}..${leaving.at(-1)?.entryId}${toolList ? `; tools: ${toolList}` : ""}${fileList ? `; files: ${fileList}` : ""}). ` +
			(core.hasTool(NOTES_TOOL) ? `Save anything you still need to ${NOTES_TOOL} now; the` : "The") +
			` transcript keeps everything${core.hasTool(SEARCH_TOOL) && core.hasTool(RECALL_TOOL) ? `, and ${SEARCH_TOOL} and ${RECALL_TOOL} find and read it later` : ""}.`;
		return {
			role: "custom",
			customType: NOTICE_TYPE,
			content: text,
			display: false,
			timestamp: 0,
		} as AgentMessage;
	}

	/**
	 * D25: the capped sections (EngineHandle.capSection) against the cap for the current limits.
	 * - A pending section (a refresh for the next cut) over the cap is composed again for it: nothing sent changes.
	 * - The section in effect is composed again only when the window shrank: the cap is below the one last seen
	 *   for it (or this is the first request of the session) and the section is over the new cap. On a fixed model
	 *   the cap does not move, so the calibration ratio drifting never rewrites the system prompt. The new text is
	 *   made pending and true is returned: the request cuts now, so the cut entry records it and this request,
	 *   planned with it, fits.
	 * `reason` gets the windows for the cut's log line.
	 */
	function recapSections(
		limits: Limits,
		ratio: number,
		systemNow: () => AgentMessage | undefined,
	): string | undefined {
		let reason: string | undefined;
		for (const [name, capped] of core.cappedSections) {
			const cap = Math.min(Math.floor(capped.fraction * limits.window), capped.maxTokens);
			const seen = st.sectionCapSeen[name];
			st.sectionCapSeen[name] = { cap, window: limits.window };
			const tokens = (wrapped: string) => Math.ceil(textTokens(wrapped) * ratio);
			const over = (wrapped: string | null | undefined): wrapped is string =>
				typeof wrapped === "string" && tokens(wrapped) > cap;
			const pending = st.pendingSections[name];
			const inEffect =
				name in st.appliedSections
					? st.appliedSections[name]
					: (systemNow() as { sections?: Record<string, string | null> } | undefined)?.sections?.[name];
			const shrank = seen === undefined || cap < seen.cap;
			const effectiveOver = shrank && over(inEffect);
			if (!effectiveOver && !over(pending)) continue;
			const content = capped.recompose({ cap, tokens: (text) => tokens(systemPromptSection(name, text) ?? "") });
			if (content === undefined) continue;
			const wrapped = systemPromptSection(name, content) ?? null;
			const before = effectiveOver ? tokens(inEffect as string) : tokens(pending as string);
			const after = wrapped === null ? 0 : tokens(wrapped);
			// A recomposition no smaller than what it replaces changes nothing (a section over its cap even empty).
			if (after >= before) continue;
			st.pendingSections[name] = wrapped;
			stats.sectionRecaps++;
			log(
				`system prompt section ${name} re-capped: ${before} -> ${after} tokens (cap ${cap}, window ${limits.window})${effectiveOver ? "; applied at a cut now" : "; pending, at the next cut"}`,
			);
			if (effectiveOver)
				reason = `memory re-cap: window ${seen ? `${seen.window} -> ` : ""}${limits.window}${seen ? "" : " (session start)"}`;
		}
		return reason;
	}

	function requestWindowA(
		messages: AgentMessage[],
		ctx: ExtensionContext,
	): { result?: AgentMessage[]; estimate: number; refuse?: string; recapped?: SectionMap } {
		const limits = core.resolveLimits(ctx);
		const ratio = core.ratioFor(limits.key);
		let idx = updateIndex(ctx, limits, ratio);
		if (!aligned(idx, messages)) {
			idx = st.index = rebuildIndex(ctx, limits, ratio);
			if (!aligned(idx, messages)) {
				stats.alignMismatches++;
				log(`align mismatch window=${idx.items.length} event=${messages.length}`);
				// D25 N2: Pi's messages are sent; a shrink still re-caps the section in them for this request. The
				// cap last seen is kept, so the next aligned request sees the shrink and makes the recorded cut.
				const seen = { ...st.sectionCapSeen };
				const system = getCurrentSystemMessage(messages as never) as AgentMessage | undefined;
				const reason = recapSections(limits, ratio, () => system);
				st.sectionCapSeen = seen;
				const recapped = reason
					? Object.fromEntries(
							[...core.cappedSections.keys()].flatMap((name) =>
								name in st.pendingSections ? [[name, st.pendingSections[name]]] : [],
							),
						)
					: undefined;
				return {
					estimate: messages.reduce((sum, m) => sum + core.sendTokens(m), 0),
					...(recapped ? { recapped } : {}),
				};
			}
		}
		const high = opts.highWater * limits.budget;
		const low = opts.lowWater * limits.budget;
		const fixed = () => (idx.header ? idx.checkpointTokens + idx.headerTokens : 0);
		let projected = (fixed() + idx.total) * ratio;
		let cutNow = false;
		const systemNow = () =>
			getCurrentSystemMessage([
				...(idx.checkpoint ? [idx.checkpoint] : []),
				...idx.items.filter((i) => i.system).map((i) => i.out),
			] as never) as AgentMessage | undefined;
		// D25: a capped section over its cap for these limits (the window shrank) forces a cut at this request.
		const recapReason = recapSections(limits, ratio, systemNow);
		const recap = recapReason !== undefined;
		// D26 rollout: the first aligned request of a session whose latest cut was made with an older header format
		// (or before formats were recorded) forces a cut, so the header is made in the current format. Once per
		// session; the new cut entry records the current format, so later sessions do not cut for it again.
		let formatReason: string | undefined;
		if (!st.headerFormatChecked) {
			st.headerFormatChecked = true;
			const hv = idx.cut?.hv ?? 1;
			if (idx.cut && hv < HEADER_FORMAT) formatReason = `header format ${hv} -> ${HEADER_FORMAT}`;
		}
		const reformat = formatReason !== undefined;
		const reasons = [recapReason, formatReason].filter((r): r is string => r !== undefined);
		if (projected > high || recap || reformat) {
			const branch = ctx.sessionManager.getBranch();
			// Sections the host asked to change take effect at this cut: the cut is chosen with them.
			const current = systemNow();
			const preview = core.sectionsAtCut(false);
			const system = preview ? core.systemWith(current ? [current] : [], { sections: preview }) : current;
			const seq = (idx.cut?.seq ?? 0) + 1;
			const plan = chooseCut(
				branch,
				seq,
				system ? messageTokens(system) : 0,
				(fixedAfter) => chooseStart(idx.items, 0, fixedAfter, low, ratio, true),
				(start) => idx.items[start]?.entryId,
			);
			const fixedAfter = plan.fixedAfter;
			let next = plan.start;
			// D25: a cut made for a re-capped section keeps the system prompt whole: without an earlier checkpoint,
			// the leading system messages go into the new one (never a section-only checkpoint, N0).
			if (recap && !idx.checkpoint) next = Math.max(next, idx.items.findIndex((i) => i.system) + 1);
			const sums = suffixSums(idx.items);
			const after = (fixedAfter + sums[next]) * ratio;
			// A forced cut (D25, D26) may keep the window where it is: only the header and checkpoint change then.
			if (
				idx.items[next] &&
				(next > 0 || (recap && idx.checkpoint) || reformat) &&
				(after < projected || recap || reformat)
			) {
				const firstKeptEntryId = idx.items[next].entryId;
				const header = plan.header ?? core.makeHeader(seq, firstKeptEntryId, branch);
				const cutSections = core.sectionsAtCut(true);
				pi.appendEntry(STATE_TYPE, {
					kind: "cut",
					firstKeptEntryId,
					seq,
					header,
					hv: HEADER_FORMAT,
					...core.cutSectionsRecord(branch, cutSections),
				});
				core.logPin(header, seq);
				// Strictly after every message that existed at the cut (same-millisecond messages included).
				const at = Date.now() + 1;
				const override = cutSections ? { sections: cutSections, at } : undefined;
				const checkpoint = core.systemWith(
					[
						...(idx.checkpoint ? [idx.checkpoint] : []),
						...idx.items
							.slice(0, next)
							.filter((i) => i.system)
							.map((i) => i.out),
					],
					override,
				);
				idx.items = idx.items.slice(next);
				core.stripOverridden(idx.items, override);
				idx.total = idx.items.reduce((sum, item) => sum + item.tokens, 0);
				idx.cut = {
					firstKeptEntryId,
					seq,
					header,
					at,
					hv: HEADER_FORMAT,
					...(cutSections ? { sections: cutSections } : {}),
				};
				idx.checkpoint = checkpoint;
				idx.checkpointTokens = checkpoint ? messageTokens(checkpoint) : 0;
				idx.header = core.headerMessage(header, at);
				idx.headerTokens = messageTokens(idx.header);
				idx.noticeGiven = false;
				evictImages(idx, limits, ratio);
				const newProjected = (fixed() + idx.total) * ratio;
				stats.cuts.push({
					seq,
					mode: "a",
					where: "request",
					omitted: next,
					before: projected,
					after: newProjected,
				});
				log(
					`cut #${seq}${reasons.length ? ` (${reasons.join("; ")})` : ""} at ${next} entry=${firstKeptEntryId} ${Math.round(projected)} -> ${Math.round(newProjected)} (budget ${limits.budget}, ratio ${ratio.toFixed(3)})`,
				);
				projected = newProjected;
				cutNow = true;
			}
		}
		// D25: what the window can never drop (the system prompt in effect and the header) does not fit the budget
		// at all: refuse before sending a request the provider can only reject.
		const systemFloor = systemNow();
		const undroppable = (systemFloor ? messageTokens(systemFloor) : 0) + (idx.header ? idx.headerTokens : 0);
		if (undroppable * ratio > limits.budget)
			return {
				estimate: fixed() + idx.total,
				refuse: `PENpi: the system prompt${idx.header ? " and the context header" : ""} (about ${Math.round(undroppable * ratio)} tokens) do not fit this model's input budget (${limits.budget} tokens); nothing was sent. Choose a model with a larger window.`,
			};
		// Request-only notice at the tail when the next request will probably cut.
		let notice: AgentMessage | undefined;
		const growth = Math.max(0, ...idx.recent.slice(1).map((value, i) => value - idx.recent[i]));
		idx.recent = cutNow ? [] : [...idx.recent.slice(-5), projected];
		const threshold = high - Math.max((1 - opts.noticeFraction) * high, 1.5 * growth);
		// G3: once per cut cycle unless repeats are asked for; every cut (and a rebuild) re-arms it.
		if (
			opts.notice &&
			!cutNow &&
			projected > threshold &&
			projected <= high &&
			(opts.noticeRepeats || !idx.noticeGiven)
		) {
			const system = systemNow();
			const fixedAfter = (system ? messageTokens(system) : 0) + Math.max(idx.headerTokens, 300);
			const next = chooseStart(idx.items, 0, fixedAfter, low, ratio, true);
			if (next > 0) {
				notice = noticeFor(idx.items, next, high - projected);
				idx.noticeGiven = true;
				stats.notices++;
			}
		}
		flushDecisions();
		const capped = idx.items.some((item) => item.out !== item.message);
		if (!idx.header && !capped && !notice) return { estimate: idx.total };
		const body = idx.items.map((item) => item.out);
		if (capped) stats.capped++;
		const result = idx.header ? [...(idx.checkpoint ? [idx.checkpoint] : []), idx.header, ...body] : body;
		if (notice) result.push(notice);
		return { result, estimate: fixed() + idx.total + (notice ? messageTokens(notice) : 0) };
	}

	/**
	 * Pi's own messages with the latest cut's section override applied (unchanged without one). N0: as the
	 * checkpoint does, the system messages older than the override are merged with it into one, in place of
	 * Pi's leading system message (Pi's preamble first); newer system messages stay where they are and win.
	 * With no system message older than the cut (a transcript that starts after it), the messages are sent
	 * unchanged rather than with the section alone in front (round 4).
	 */
	function keepOverride(messages: AgentMessage[], ctx: ExtensionContext, recapped?: SectionMap): AgentMessage[] {
		const cut = core.readCut(ctx.sessionManager.getBranch());
		// D25 N2: sections re-capped for this request (a shrink on a request the engine cannot align) go on top.
		const sections = recapped ? { ...(cut?.sections ?? {}), ...recapped } : cut?.sections;
		if (!sections) return messages;
		const at = cut?.at ?? Number.POSITIVE_INFINITY;
		const older = messages.filter((m) => m.role === "system" && timeOf(m) < at);
		if (older.length === 0) return messages;
		const merged = core.systemWith(older, { sections, at });
		if (!merged) return messages;
		const first = messages.indexOf(older[0]);
		const out: AgentMessage[] = [];
		messages.forEach((message, index) => {
			if (index === first) out.push(merged);
			if (!older.includes(message)) out.push(message);
		});
		return out;
	}

	const sendTotal = (messages: AgentMessage[]) => messages.reduce((sum, m) => sum + core.sendTokens(m), 0);

	pi.on("context_with_system", (event, ctx) => {
		if (st.refused) {
			ctx.abort();
			return undefined;
		}
		let result: AgentMessage[] | undefined;
		let estimate: number | undefined;
		let recapped: SectionMap | undefined;
		const started = performance.now();
		// D24: the provider a response names belongs to that response (a failed one is never calibrated).
		st.streamProvider = undefined;
		if (Object.keys(st.appliedSections).length > 0) core.pruneApplied(ctx.sessionManager.getBranch());
		const visible = opts.hiddenCustomTypes.length > 0 ? event.messages.filter((m) => !hidden(m)) : event.messages;
		try {
			let refuse: string | undefined;
			({ result, estimate, refuse, recapped } = requestWindowA(visible, ctx));
			if (refuse) {
				log(refuse);
				ctx.ui.notify(refuse, "error");
				ctx.abort();
				return undefined;
			}
		} catch (error) {
			log(`context_with_system error: ${error instanceof Error ? error.stack : String(error)}`);
		}
		// Later 5: when the engine sends Pi's own messages (no cut yet, an alignment mismatch, an error above),
		// a section changed at a cut stays changed: the latest cut's override, over the older system messages.
		if (!result && (Object.keys(st.appliedSections).length > 0 || st.index?.cut?.sections || recapped)) {
			const kept = keepOverride(visible, ctx, recapped);
			if (kept !== visible) {
				result = kept;
				// D17: the estimate is of Pi's messages; what is sent carries the cut's section instead of Pi's.
				if (estimate !== undefined) estimate += sendTotal(kept) - sendTotal(visible);
			}
		}
		// RC6: a tool call with no name or no id is repaired in what is sent (the session keeps it as recorded).
		const unrepaired = result ?? visible;
		const repair = repairToolCalls(unrepaired);
		if (repair.messages !== unrepaired) {
			result = repair.messages;
			// As D17: the estimate is of the messages before the repair; what is sent is the repaired request.
			if (estimate !== undefined) estimate += sendTotal(result) - sendTotal(unrepaired);
			stats.toolCallRepairs++;
			for (const kind of repair.kinds) {
				if (st.repairsLogged.has(kind)) continue;
				st.repairsLogged.add(kind);
				log(
					`tool-call repair (${kind}): the request leaves out or re-ids a broken tool call; the session is unchanged`,
				);
			}
		}
		// E3: remember the estimate of exactly what is sent; message_end pairs it with provider usage.
		const sentMessages = result ?? visible;
		const limits = core.resolveLimits(ctx);
		estimate ??= sendTotal(sentMessages);
		// What this request appended to the previous one (the silent-truncation evidence).
		const shape = requestShape(sentMessages);
		const appendOnly =
			st.sentShape !== undefined &&
			shape.keys.length >= st.sentShape.keys.length &&
			st.sentShape.keys.every((k, i) => shape.keys[i] === k);
		let appendedText = 0;
		// The replay check (detector): reasoning Pi replays, which providers count or ignore, and thinking
		// sent as text, which every provider counts.
		let appendedReplay = 0;
		let appendedAsText = 0;
		let afterLengthStop = false;
		if (appendOnly) {
			for (const m of sentMessages.slice(st.sentShape!.keys.length, shape.keys.length)) {
				// What Pi sends, without any replayed reasoning (providers differ in counting it) or images.
				const sent = core.parts(m);
				appendedText += sent.tokens === 0 ? 0 : sent.tokens - sent.reasoning - messageImageTokens(m);
				if (sent.tokens > 0) {
					appendedReplay += sent.reasoning - (sent.asText ?? 0);
					appendedAsText += sent.asText ?? 0;
				}
				if (m.role === "assistant" && (m as AssistantMessage).stopReason === "length") afterLengthStop = true;
			}
		}
		const noticeDrop = st.sentShape?.noticeTokens ?? 0;
		// D24 R1: a request after a length stop starts a new chain too. What a provider counts of a cut answer is
		// provider-specific, so no span used to judge a switch may contain one.
		if (appendOnly && !afterLengthStop) st.appendCum += appendedText - noticeDrop;
		else {
			st.appendChain++;
			st.appendCum = 0;
		}
		st.lastSent = {
			estimate,
			key: limits.key,
			seq: ++st.sendSeq,
			appendOnly,
			appendedText,
			appendedReplay,
			appendedAsText,
			noticeDrop,
			afterLengthStop,
			chain: st.appendChain,
			cum: st.appendCum,
		};
		st.sentShape = shape;
		stats.sent.push({ estimate, ratio: core.ratioFor(limits.key), budget: limits.budget, appended: appendedText });
		stats.pinTokens.push(core.requestPinTokens(sentMessages));
		stats.handlerMs.push(performance.now() - started);
		st.lastRequestTokens = estimate * core.ratioFor(limits.key);
		core.updateStatus(ctx, limits);
		if (result) return { messages: result };
		return visible !== event.messages ? { messages: visible } : undefined;
	});

	// ---------------------------------------------------------- boundaries (E2 b, E5, E6, H4)
	function buildSlots(
		entries: ProjectedSessionEntry[],
		limits: Limits,
		ratio: number,
	): { slots: Item[]; overhead: AgentMessage[] } {
		const slots: Item[] = [];
		const overhead: AgentMessage[] = [];
		for (const projected of entries) {
			const isCompaction = projected.sourceEntry.type === "compaction";
			for (const message of projected.messages) {
				if (message.role === "system" || isCompaction) {
					overhead.push(message);
					continue;
				}
				slots.push(itemFor(projected.sourceEntry.id, message, limits, ratio));
			}
		}
		return { slots, overhead };
	}
	core.buildSlots = buildSlots;
}
