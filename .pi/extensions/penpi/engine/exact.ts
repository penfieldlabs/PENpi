/**
 * Exact counts for the budget (0.9.0, design sections 2 to 4): which tokenizer counts the current model, the counts
 * of what a request sends, and the cache they live in. Detection stays on the estimate in this release's commit 4;
 * only the budget reads these counts.
 *
 * - **The path.** The classifier (tokenizers/classify.ts) names the model's entry. An entry that is "exact" or
 *   "assumed" counts for the budget; the files come from TokenizerFiles (the `tokenizer` setting, PENPI_TOKENIZER,
 *   and PI_OFFLINE, under which "auto" acts as "local"), and the worker loads one at a time (tokenizers/counter.ts).
 *   Until it is ready, and when it fails, every part is on the estimate.
 * - **The counts** are what serializedParts prices, with each text counted by the tokenizer in place of the estimate:
 *   the same rules, so a message the serializer drops counts nothing on either path. Images keep their formula. A
 *   text holding special-token-like strings is counted both ways (the band), and the budget takes the larger.
 * - **The cache:** per entry and serialize target, by the message object (the session's own objects, which the
 *   planner's index holds across requests, and the capped copies it keeps), and, for messages rebuilt on each request
 *   (the window header, the checkpoint, the notice, an override's system message), by their content in an LRU of
 *   4,096 entries. A message is counted when a request first carries it.
 * - **The counting line:** once per session, when the path settles, the engine log gets `telemetry {"k":"counting",
 *   "path":"exact"|"fallback","entry":<name or null>,"reason":<why fallback, or null>}`, with `"assumed":true` for a name
 *   only assumed to match its tokenizer (exact for the budget, the fallback rules for detection), and the telemetry report gets
 *   the same JSON. A later change of path (a model switch, a worker failure) logs the new one.
 * - **Notices:** the first download of a file (TokenizerFiles), and, once per session and model, "counting <model>
 *   with the estimate (<reason>)" when the reason is something the user can change or should know: offline, a failed
 *   download, a hash mismatch, a failed worker. A model with no public tokenizer, or the estimate turned on, gets the
 *   log line only.
 */
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { type AgentMessage, messageImageTokens } from "./estimator.ts";
import { serializedParts } from "./serializer.ts";
import { classifyModel } from "./tokenizers/classify.ts";
import { type CountChunk, TokenCounter } from "./tokenizers/counter.ts";
import { describeEntry } from "./tokenizers/describe.ts";
import {
	type FallbackReason,
	fallbackNotice,
	TokenizerFiles,
	type TokenizerMode,
	tokenizerCacheDir,
	tokenizerMode,
} from "./tokenizers/download.ts";
import { pinnedRule, type ReasoningRule, type TemplateTokens } from "./tokenizers/reasoning.ts";
import { type TokenizerEntry, tokenizerEntry } from "./tokenizers/table.ts";

/** A message's exact parts: serializedParts with text counted by the tokenizer, and the band's width. */
export interface ExactParts {
	tokens: number;
	reasoning: number;
	asText?: number;
	/** Tokens between counting special-token-like strings as one token and as text. */
	band: number;
	/**
	 * 0.9.0 detection: `tokens` without the serializer's per-message and per-tool-call overheads, and without images:
	 * the text the tokenizer counted. An image's cost is the provider's own rule, which no tokenizer counts.
	 */
	raw: number;
	/** Whether the message carries an image. */
	images: boolean;
	/**
	 * 0.9.0 detection, the absolute bound's text count: the system prompt and its sections, user text and tool-result
	 * text, each trimmed. Assistant text, tool calls, reasoning and images are left out.
	 */
	text: number;
	/** An assistant message's own text, for gpt-oss's rule, which drops a tool-call turn's text with its reasoning. */
	said: number;
	/** Whether an assistant message calls tools (its turn is not a final answer). */
	calls: boolean;
}

/** Whitespace a trim takes off that is worth counting the trimmed text for (below this, the untrimmed count is used). */
const TRIM_COUNTED = 16;

/** The texts the absolute bound counts in a message, untrimmed (section 5): system, user and tool-result text. */
function boundTexts(message: AgentMessage): string[] {
	const m = message as { role: string; content?: unknown; sections?: Record<string, string | null> };
	if (m.role !== "system" && m.role !== "user" && m.role !== "toolResult") return [];
	const out: string[] = [];
	if (typeof m.content === "string") out.push(m.content);
	else if (Array.isArray(m.content))
		for (const b of m.content as Array<{ type: string; text?: string }>)
			if (b.type === "text" && b.text) out.push(b.text);
	if (m.role === "system") for (const s of Object.values(m.sections ?? {})) if (s) out.push(s);
	return out;
}

/** The trimmed form the bound counts, when a trim takes off enough to matter. */
function trimmed(text: string): string | undefined {
	const t = text.trim();
	return text.length - t.length > TRIM_COUNTED ? t : undefined;
}

/** The serializer's overheads in a message's tokens: 4 a message sent, 8 a tool call, 30 a summary. */
function overheadOf(message: AgentMessage, tokens: number): number {
	if (tokens === 0) return 0;
	const m = message as { role: string; content?: unknown };
	let overhead = 4;
	if (m.role === "assistant" && Array.isArray(m.content))
		overhead += 8 * (m.content as Array<{ type: string }>).filter((b) => b.type === "toolCall").length;
	if (m.role === "compactionSummary" || m.role === "branchSummary") overhead += 30;
	return Math.min(overhead, tokens);
}

/** What detection reads of a request counted whole (detector.ts, section 5). */
export interface ExactRequest {
	/** The request as the model's template renders it, in raw exact tokens: its reasoning rule applied. */
	rendered: number;
	/** The absolute bound's text count, and the band, of the whole request. */
	text: number;
	band: number;
	/** Of the append (the messages after the previous request's): how many send anything, and their band. */
	appendedMessages: number;
	appendedBand: number;
	/** The append carries an image, whose cost the provider prices by its own rule. */
	appendedImages: boolean;
	/** The append's tool calls and their arguments, for a template's tokens around them (TemplateTokens). */
	appendedCalls: number;
	appendedArguments: number;
	/** Why this sample is judged on the fallback rules, when it is. */
	fallback?: string;
}

/**
 * Detection's figures for a request whose every part was counted, `parts` aligned with `sent`. `previous` is the
 * previous request's message count when this one is append-only (its append is `sent.slice(previous)`).
 * - **Rendered:** raw exact tokens, less the reasoning (and, for gpt-oss, the text) the model's template leaves out.
 * - **Fallback samples:** a template that renders no reasoning with reasoning in the append; a model whose rule isn't
 *   pinned, on an append that crosses a user message after reasoning-bearing turns.
 */
export function exactRequest(
	sent: AgentMessage[],
	parts: ExactParts[],
	previous: number | undefined,
	rule: ReasoningRule | undefined,
): ExactRequest {
	const role = (i: number) => (sent[i] as { role: string }).role;
	let lastUser = -1;
	let lastFinal = -1;
	for (let i = 0; i < sent.length; i++) {
		if (role(i) === "user" && parts[i].tokens > 0) lastUser = i;
		if (role(i) === "assistant" && parts[i].tokens > 0 && !parts[i].calls) lastFinal = i;
	}
	let rendered = 0;
	let text = 0;
	let band = 0;
	for (let i = 0; i < sent.length; i++) {
		const p = parts[i];
		let r = p.raw;
		if (role(i) === "assistant") {
			const before =
				rule === "drop"
					? i < lastUser
					: rule === "after-final" || rule === "after-final-text"
						? i <= lastFinal
						: false;
			if (before) r -= p.reasoning - (p.asText ?? 0);
			if (before && rule === "after-final-text" && p.calls) r -= p.said;
		}
		rendered += Math.max(0, r);
		text += p.text;
		band += p.band;
	}
	let appendedMessages = 0;
	let appendedBand = 0;
	let appendedImages = false;
	let appendedCalls = 0;
	let appendedArguments = 0;
	let fallback: string | undefined;
	if (previous !== undefined) {
		let reasoningBefore = false;
		for (let i = 0; i < previous; i++) if (role(i) === "assistant" && parts[i].reasoning > 0) reasoningBefore = true;
		for (let i = previous; i < sent.length; i++) {
			if (parts[i].tokens === 0) continue;
			appendedMessages++;
			appendedBand += parts[i].band;
			if (parts[i].images) appendedImages = true;
			const content = (sent[i] as { content?: unknown }).content;
			if (role(i) === "assistant" && Array.isArray(content))
				for (const b of content as Array<{ type: string; arguments?: unknown }>) {
					if (b.type !== "toolCall") continue;
					appendedCalls++;
					if (b.arguments && typeof b.arguments === "object") appendedArguments += Object.keys(b.arguments).length;
				}
			if (rule === "none" && role(i) === "assistant" && parts[i].reasoning > 0)
				fallback ??= "reasoning in the append, for a template that renders none";
			if (rule === undefined && role(i) === "user" && reasoningBefore)
				fallback ??= "a user message after reasoning-bearing turns, for a model whose reasoning rule isn't pinned";
			if (role(i) === "assistant" && parts[i].reasoning > 0) reasoningBefore = true;
		}
	}
	return {
		rendered,
		text,
		band,
		appendedMessages,
		appendedBand,
		appendedImages,
		appendedCalls,
		appendedArguments,
		...(fallback ? { fallback } : {}),
	};
}

/** The handler waits at least this long for counts, or as long as the misses should take if longer. */
export const COUNT_WAIT_MS = 200;
/** Misses that should take longer than this aren't waited for: they go to the background count. */
export const COUNT_WAIT_CAP_MS = 1000;
/** Rebuilt messages up to this many characters are also cached by their content. */
const CONTENT_KEY_CHARS = 256 * 1024;
export const LRU_SIZE = 4096;

export interface ExactApi {
	/** The entry counting for the budget now, when its tokenizer is ready. */
	ready: () => TokenizerEntry | undefined;
	/** For detection: whether the name is only assumed, and the model's reasoning rule (undefined: not pinned). */
	detection: () =>
		| { assumed: boolean; reasoning: ReasoningRule | undefined; template: TemplateTokens | undefined }
		| undefined;
	/** The exact ratio's key for a model key on the current entry. */
	key: (modelKey: string) => string | undefined;
	/** A message's exact parts, if counted. */
	parts: (message: AgentMessage) => ExactParts | undefined;
	/** Budget tokens of a message on the exact path (as sendTokens: replayed reasoning out when it is ignored). */
	sendTokens: (message: AgentMessage) => number | undefined;
	/** Pick the model's tokenizer, and count the misses among `messages`: awaited up to the deadline. Never throws. */
	prepare: (ctx: ExtensionContext, messages: AgentMessage[]) => Promise<void>;
	/** Count the misses among `messages` in the background, newest first. */
	background: (messages: AgentMessage[]) => void;
	counter: TokenCounter;
	files: () => TokenizerFiles;
	/** The counting path in force, for the doctor and tests. */
	path: () => { path: "exact" | "fallback" | "pending"; entry: string | null; reason: string | null };
}

function isTruthy(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value ?? "");
}

export function installExact(core: EngineCore): void {
	const { pi, opts, log, st } = core;
	const env = opts.env ?? process.env;
	// tokenizerMode warns once here, at the one call that reads the setting and PENPI_TOKENIZER.
	const warn = (message: string) => {
		log(message);
		console.warn(`[context-engine] ${message}`);
	};
	const setting = tokenizerMode(opts.tokenizer, env, warn);
	// Pi's --offline sets PI_OFFLINE; "auto" then makes no request, as "local".
	const mode: TokenizerMode = setting === "auto" && isTruthy(env.PI_OFFLINE) ? "local" : setting;
	let lastCtx: ExtensionContext | undefined;
	const notify = (message: string, level: "info" | "warning") => {
		log(message);
		const ctx = lastCtx;
		try {
			if (ctx?.hasUI) ctx.ui.notify(message, level);
			else process.stderr.write(`${message}\n`);
		} catch {}
	};
	let filesCache: TokenizerFiles | undefined;
	const files = () => {
		filesCache ??= new TokenizerFiles({
			dir: opts.tokenizerCacheDir ?? tokenizerCacheDir(getAgentDir()),
			mode,
			notify: (message) => notify(message, "info"),
		});
		return filesCache;
	};

	// ---------------------------------------------------------------- the path, per session
	let selected:
		| {
				model: string;
				entry?: TokenizerEntry;
				reason?: FallbackReason;
				/** An assumed name: exact for the budget, the fallback rules for detection. */
				assumed?: boolean;
				reasoning?: ReasoningRule;
				template?: TemplateTokens;
		  }
		| undefined;
	let logged: string | undefined;
	let noticed = new Set<string>();
	// An assumed name counts exactly for the budget, and stays on the fallback rules for detection: its line says so.
	const report = (path: "exact" | "fallback", entry: string | null, reason: string | null, assumed = false) => {
		const json = JSON.stringify({ k: "counting", path, entry, reason, ...(assumed ? { assumed: true } : {}) });
		if (json === logged) return;
		logged = json;
		opts.report?.(json);
		if (!opts.report) log(`telemetry ${json}`);
	};
	const fallback = (model: string, reason: FallbackReason) => {
		report("fallback", null, reason);
		const quiet = reason === "no public tokenizer" || reason === "turned off";
		if (quiet || noticed.has(model)) return;
		noticed.add(model);
		notify(fallbackNotice(model, reason), "warning");
	};
	const counter = new TokenCounter({
		file: (entry) => files().file(entry),
		describe: describeEntry,
		log,
		...(opts.tokenizerWorker ? { startWorker: opts.tokenizerWorker } : {}),
		onState: (state, entry, reason) => {
			if (!selected || selected.entry?.id !== entry.id) return;
			if (state === "ready") report("exact", entry.id, null, selected.assumed);
			else fallback(selected.model, reason ?? "tokenizer worker failed");
		},
	});
	// The worker and its tokenizer belong to the session: freed when it ends.
	pi.on("session_shutdown", () => {
		counter.end();
	});
	// The tokenizer starts loading with the session and at a model change, not at the first request: the path settles
	// before the first request, and a short session still gets its counting line.
	const early = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		try {
			select(ctx);
		} catch (error) {
			log(`exact count error: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	pi.on("model_select", (_event, ctx) => early(ctx));
	pi.on("session_start", (_event, ctx) => {
		logged = undefined;
		noticed = new Set();
		selected = undefined;
		early(ctx);
	});

	function select(ctx: ExtensionContext): void {
		const model = ctx.model;
		const id = model ? `${model.provider}/${model.id}` : "?";
		if (selected?.model === id) return;
		if (mode === "estimate") {
			selected = { model: id, reason: "turned off" };
			counter.end();
			fallback(id, "turned off");
			return;
		}
		// Tests and E2 name a model's entry and reasoning rule (exactModels); otherwise the classifier and the pinned rules.
		const named = opts.exactModels?.[id];
		const cls = named
			? { status: named.status ?? ("exact" as const), entry: named.entry }
			: model
				? classifyModel(model.id)
				: { status: "none" as const };
		const entry = cls.entry ? tokenizerEntry(cls.entry) : undefined;
		if (!entry || (cls.status !== "exact" && cls.status !== "assumed")) {
			selected = { model: id, reason: "no public tokenizer" };
			// A switch to a model with no tokenizer frees the old one.
			counter.end();
			fallback(id, "no public tokenizer");
			return;
		}
		selected = {
			model: id,
			entry,
			assumed: cls.status === "assumed",
			reasoning: named ? named.reasoning : model ? pinnedRule(model.id)?.rule : undefined,
			template: named ? named.templateTokens : model ? pinnedRule(model.id)?.templateTokens : undefined,
		};
		if (counter.entry?.id === entry.id && counter.state === "ready") {
			report("exact", entry.id, null, selected.assumed);
			return;
		}
		if (counter.entry?.id === entry.id && counter.state === "failed") {
			fallback(id, counter.reason ?? "tokenizer worker failed");
			return;
		}
		void counter.use(entry);
	}

	// ---------------------------------------------------------------- the cache
	const byObject = new Map<string, WeakMap<object, ExactParts>>();
	const byContent = new Map<string, ExactParts>();
	const inFlight = new Map<string, WeakSet<object>>();
	const cacheKey = (entry: TokenizerEntry) => `${entry.id}|${st.targetKey}`;
	const objects = (key: string) => {
		let map = byObject.get(key);
		if (!map) {
			map = new WeakMap();
			byObject.set(key, map);
		}
		return map;
	};
	const flying = (key: string) => {
		let set = inFlight.get(key);
		if (!set) {
			set = new WeakSet();
			inFlight.set(key, set);
		}
		return set;
	};

	/** The distinct texts serializedParts prices in a message, in order. */
	function textsOf(message: AgentMessage): string[] {
		const texts = new Set<string>();
		serializedParts(message, st.target, (text) => {
			if (text.length > 0) texts.add(text);
			return 0;
		});
		// The absolute bound's texts: trimmed, when the trim matters, as an extra text to count.
		for (const text of boundTexts(message)) {
			const t = trimmed(text);
			texts.add(t ?? text);
		}
		texts.delete("");
		return [...texts];
	}

	/** A rebuilt message's content key (role, type and texts), when it is small enough to hash every request. */
	function contentKey(message: AgentMessage, texts: string[]): string | undefined {
		const m = message as { role: string; customType?: string };
		if (m.role !== "system" && m.role !== "custom") return undefined;
		if (texts.reduce((sum, t) => sum + t.length, 0) > CONTENT_KEY_CHARS) return undefined;
		return createHash("sha1")
			.update(`${m.role}\0${m.customType ?? ""}\0${texts.join("\0")}`)
			.digest("base64");
	}

	function remember(key: string, content: string | undefined, message: AgentMessage, parts: ExactParts): void {
		objects(key).set(message, parts);
		if (content === undefined) return;
		byContent.delete(`${key}|${content}`);
		byContent.set(`${key}|${content}`, parts);
		while (byContent.size > LRU_SIZE) byContent.delete(byContent.keys().next().value as string);
	}

	function parts(message: AgentMessage): ExactParts | undefined {
		const entry = ready();
		if (!entry) return undefined;
		const key = cacheKey(entry);
		const hit = objects(key).get(message);
		if (hit) return hit;
		const m = message as { role: string };
		if (m.role !== "system" && m.role !== "custom") return undefined;
		const content = contentKey(message, textsOf(message));
		const found = content === undefined ? undefined : byContent.get(`${key}|${content}`);
		if (found) {
			// Most recently used.
			byContent.delete(`${key}|${content}`);
			byContent.set(`${key}|${content}`, found);
			objects(key).set(message, found);
		}
		return found;
	}

	function ready(): TokenizerEntry | undefined {
		if (!selected?.entry || counter.state !== "ready" || counter.entry?.id !== selected.entry.id) return undefined;
		return selected.entry;
	}

	/**
	 * Send the misses among `messages` to the worker as one call. Each message's parts are stored once all its texts are
	 * counted. Returns the call's promise and its predicted time, or undefined with nothing to count.
	 */
	function send(
		messages: AgentMessage[],
		priority: "request" | "background",
	): { done: Promise<void>; predicted: number } | undefined {
		const entry = ready();
		if (!entry) return undefined;
		const key = cacheKey(entry);
		const target = st.target;
		const pending = flying(key);
		const owners: Array<{ message: AgentMessage; texts: string[]; content?: string }> = [];
		const index = new Map<string, number>();
		const texts: string[] = [];
		for (const message of messages) {
			if (objects(key).has(message) || pending.has(message) || parts(message)) continue;
			const own = textsOf(message);
			owners.push({ message, texts: own, content: contentKey(message, own) });
			pending.add(message);
			for (const t of own) {
				if (index.has(t)) continue;
				index.set(t, texts.length);
				texts.push(t);
			}
		}
		if (owners.length === 0) return undefined;
		const counts = new Array<number | undefined>(texts.length);
		const asText = new Map<number, number>();
		let finished = 0;
		const complete = (o: (typeof owners)[number]) => o.texts.every((t) => counts[index.get(t)!] !== undefined);
		const settle = (o: (typeof owners)[number]) => {
			pending.delete(o.message);
			// The budget takes the larger of the band's two counts.
			const big = (t: string) => {
				const i = index.get(t)!;
				return Math.max(counts[i]!, asText.get(i) ?? 0);
			};
			let band = 0;
			for (const t of o.texts) {
				const i = index.get(t)!;
				const other = asText.get(i);
				if (other !== undefined) band += Math.abs(other - counts[i]!);
			}
			const p = serializedParts(o.message, target, (t) => (t.length === 0 ? 0 : big(t)));
			let text = 0;
			for (const t of boundTexts(o.message)) {
				const form = trimmed(t) ?? t;
				if (form.length > 0) text += big(form);
			}
			const m = o.message as { role: string; content?: unknown };
			const blocks =
				m.role === "assistant" && Array.isArray(m.content)
					? (m.content as Array<{ type: string; text?: string }>)
					: [];
			const said = blocks.reduce((n, b) => n + (b.type === "text" && (b.text ?? "").trim() ? big(b.text!) : 0), 0);
			const calls = blocks.some((b) => b.type === "toolCall");
			const image = p.tokens > 0 ? messageImageTokens(o.message) : 0;
			remember(key, o.content, o.message, {
				...p,
				band,
				raw: Math.max(0, p.tokens - overheadOf(o.message, p.tokens) - image),
				images: image > 0,
				text,
				said,
				calls,
			});
		};
		const left = new Set(owners);
		const onChunk = (chunk: CountChunk) => {
			chunk.counts.forEach((n, i) => {
				counts[chunk.from + i] = n;
			});
			for (const [i, n] of chunk.bands ?? []) asText.set(i, n);
			for (const o of left) {
				if (!complete(o)) continue;
				left.delete(o);
				settle(o);
				finished++;
			}
		};
		const chars = texts.reduce((sum, t) => sum + t.length, 0);
		const call = counter.count(texts, priority, onChunk);
		core.stats.exact.calls++;
		core.stats.exact.texts += texts.length;
		const done = call.done.finally(() => {
			for (const o of left) pending.delete(o.message);
		});
		done.catch((error: unknown) =>
			log(
				`exact count failed after ${finished} of ${owners.length}: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		return { done, predicted: counter.predictMs(chars) };
	}

	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

	core.exact = {
		ready,
		detection: () =>
			ready()
				? { assumed: selected?.assumed ?? false, reasoning: selected?.reasoning, template: selected?.template }
				: undefined,
		key: (modelKey) => {
			const entry = ready();
			return entry ? `${modelKey}#${entry.id}` : undefined;
		},
		parts,
		sendTokens: (message) => {
			const p = parts(message);
			if (!p) return undefined;
			return st.replayIgnored ? p.tokens - (p.reasoning - (p.asText ?? 0)) : p.tokens;
		},
		prepare: async (ctx, messages) => {
			lastCtx = ctx;
			try {
				select(ctx);
				// Loading: one macrotask, so the worker's answers get in even when nothing else yields between requests
				// (a scripted session, or E2). A request on a real network yields anyway.
				if (counter.state === "loading") await new Promise<void>((resolve) => setTimeout(resolve, 0));
				if (!ready()) return;
				const entry = ready()!;
				const key = cacheKey(entry);
				const misses = messages.filter((m) => !objects(key).has(m) && !flying(key).has(m));
				if (misses.length === 0) return;
				const chars = misses.reduce((sum, m) => sum + textsOf(m).reduce((s, t) => s + t.length, 0), 0);
				const predicted = counter.predictMs(chars);
				// A resume's first request, say: not waited for; counted in the background, newest first.
				if (predicted > COUNT_WAIT_CAP_MS) {
					send([...misses].reverse(), "background");
					return;
				}
				const call = send(misses, "request");
				if (!call) return;
				await Promise.race([call.done.catch(() => undefined), sleep(Math.max(COUNT_WAIT_MS, predicted))]);
			} catch (error) {
				log(`exact count error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		background: (messages) => {
			try {
				send([...messages].reverse(), "background");
			} catch (error) {
				log(`exact count error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		counter,
		files,
		path: () => {
			if (!selected) return { path: "pending", entry: null, reason: null };
			if (ready()) return { path: "exact", entry: selected.entry!.id, reason: null };
			if (selected.reason) return { path: "fallback", entry: null, reason: selected.reason };
			if (counter.state === "failed") return { path: "fallback", entry: null, reason: counter.reason ?? null };
			return { path: "pending", entry: selected.entry?.id ?? null, reason: null };
		},
	};
}
