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
 *   "path":"exact"|"fallback","entry":<name or null>,"reason":<why fallback, or null>}`, and the telemetry report gets
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
import type { AgentMessage } from "./estimator.ts";
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
import { type TokenizerEntry, tokenizerEntry } from "./tokenizers/table.ts";

/** A message's exact parts: serializedParts with text counted by the tokenizer, and the band's width. */
export interface ExactParts {
	tokens: number;
	reasoning: number;
	asText?: number;
	/** Tokens between counting special-token-like strings as one token and as text. */
	band: number;
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
	let selected: { model: string; entry?: TokenizerEntry; reason?: FallbackReason } | undefined;
	let logged: string | undefined;
	let noticed = new Set<string>();
	const report = (path: "exact" | "fallback", entry: string | null, reason: string | null) => {
		const json = JSON.stringify({ k: "counting", path, entry, reason });
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
			if (state === "ready") report("exact", entry.id, null);
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
		const cls = model ? classifyModel(model.id) : { status: "none" as const };
		const entry = cls.entry ? tokenizerEntry(cls.entry) : undefined;
		if (!entry || (cls.status !== "exact" && cls.status !== "assumed")) {
			selected = { model: id, reason: "no public tokenizer" };
			// A switch to a model with no tokenizer frees the old one.
			counter.end();
			fallback(id, "no public tokenizer");
			return;
		}
		selected = { model: id, entry };
		if (counter.entry?.id === entry.id && counter.state === "ready") {
			report("exact", entry.id, null);
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
			remember(key, o.content, o.message, { ...p, band });
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
