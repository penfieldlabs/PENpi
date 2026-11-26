/**
 * The main thread's side of the tokenizer worker (0.9.0, design section 2): one worker, one tokenizer, counts in
 * chunks, watchdogs, one restart.
 *
 * - `use(entry)` makes the worker count with that entry. A different entry ends the worker first and starts another,
 *   so two tokenizer files never sit in memory together. The bytes come from TokenizerFiles, verified, and are
 *   transferred to the worker: the buffer is single-use, so it is fetched again for a restart (file() shares one
 *   in-flight buffer between callers, and a transfer detaches it for all of them; this class is its only caller).
 * - `count(texts, priority)` sends one call. Its chunks land as the worker sends them (`onChunk`), so a caller that
 *   stops waiting at a deadline keeps whatever is done, and the rest still lands later.
 * - A crash (`error`, `exit`) or a watchdog miss ends the worker and rejects every pending call. The worker restarts
 *   once and loads the tokenizer again. If the restart fails, or the worker fails again, the tokenizer is failed for
 *   the session ("tokenizer worker failed").
 * - Watchdogs: a load gets the larger of 30 s and about 1 s per MB. While any count is pending, the worker must answer
 *   (a chunk, a done, or `building`) within the larger of 2 s and ten times what the longest pending text should take,
 *   or a load's allowance after `building`. One watchdog for the worker, not one per call: a call waiting in the
 *   worker's queue behind another isn't late while the worker is working.
 * - Nothing here throws to its caller: a failed count rejects its own promise, which the engine catches.
 */
import { Worker } from "node:worker_threads";
import type { FallbackReason, TokenizerFile } from "./download.ts";
import type { TokenizerEntry } from "./table.ts";

/** What the worker is told about an entry besides its bytes. */
export interface WorkerEntry {
	id: string;
	loader: TokenizerEntry["loader"];
	/** The split pattern and specials, for a tiktoken file (Kimi), which carries neither. */
	pattern?: string;
	specials?: Record<string, number>;
	/** The family's prior rate, in characters per millisecond. */
	charsPerMs?: number;
}

/** The worker, as this class uses it; tests pass a fake. */
export interface TokenizerWorker {
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
	on(event: "message", listener: (message: WorkerReply) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (code: number) => void): unknown;
	terminate(): Promise<number> | undefined;
	/** So the worker never keeps the process alive. Called after the listeners are attached, which ref it again. */
	unref?(): void;
}

export type WorkerReply =
	| { type: "ready"; id: string; ms: number; charsPerMs?: number }
	| { type: "failed"; reason: string }
	| {
			type: "chunk";
			id: number;
			from: number;
			counts: number[];
			bands?: Array<[number, number]>;
			ms: number;
			chars: number;
	  }
	| { type: "done"; id: number }
	/** The band's second instance is being built for this count: as long as a load. */
	| { type: "building"; id: number };

/** The tokenizer worker, with a heap limit so a runaway load can't take Pi down. */
export function startTokenizerWorker(): TokenizerWorker {
	return new Worker(new URL("../tokenizer-worker.mjs", import.meta.url), {
		resourceLimits: { maxOldGenerationSizeMb: 768 },
	}) as unknown as TokenizerWorker;
}

export type CounterState = "idle" | "loading" | "ready" | "failed";

export interface CountChunk {
	/** Index of the first text the counts are for. */
	from: number;
	counts: number[];
	/** [index, count as text] for texts holding special-token-like strings: the band's other end. */
	bands?: Array<[number, number]>;
}

export interface CounterOptions {
	/** The verified bytes of an entry (TokenizerFiles.file). */
	file: (entry: TokenizerEntry) => Promise<TokenizerFile>;
	/** What the worker needs besides the bytes. */
	describe: (entry: TokenizerEntry) => WorkerEntry;
	startWorker?: () => TokenizerWorker;
	/** Engine log lines. */
	log?: (line: string) => void;
	/** Called when the state settles: ready, or failed with a reason. */
	onState?: (state: CounterState, entry: TokenizerEntry, reason?: FallbackReason) => void;
	/** Watchdogs, in ms (tests shorten them). */
	loadWatchdogMs?: (bytes: number) => number;
	/** The least time the worker may take to answer while counting (default WATCHDOG_MIN_MS). */
	watchdogMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

interface PendingCall {
	id: number;
	texts: string[];
	priority: "request" | "background";
	onChunk?: (chunk: CountChunk) => void;
	resolve: () => void;
	reject: (error: Error) => void;
	/** The longest text's length, for the watchdog: the worker never splits a text across chunks. */
	longest: number;
}

export const LOAD_WATCHDOG_MIN_MS = 30_000;
export const WATCHDOG_MIN_MS = 2_000;
/** A chunk's target length in the worker. */
export const CHUNK_MS = 50;

export class TokenCounter {
	state: CounterState = "idle";
	entry?: TokenizerEntry;
	reason?: FallbackReason;
	/** Characters per millisecond, as measured from the worker's chunks (the family's prior until then). */
	charsPerMs = 300;
	/** Load time of the current tokenizer, and restarts in this session. */
	loadMs?: number;
	restarts = 0;
	/** Calls sent and texts counted, for tests and the doctor. */
	calls = 0;
	texts = 0;
	private readonly options: CounterOptions;
	private worker?: TokenizerWorker;
	private generation = 0;
	private nextId = 1;
	private readonly pending = new Map<number, PendingCall>();
	private loading?: Promise<void>;
	private loadTimer?: unknown;
	/** The worker-level watchdog while counts are pending. */
	private progressTimer?: unknown;

	constructor(options: CounterOptions) {
		this.options = options;
	}

	private setTimer(fn: () => void, ms: number): unknown {
		return (this.options.setTimer ?? ((f, t) => setTimeout(f, t).unref?.()))(fn, ms);
	}

	private clearTimer(timer: unknown): void {
		if (timer === undefined) return;
		(this.options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(timer);
	}

	/** Count with `entry` from now on. Resolves once the state settles; never rejects. */
	use(entry: TokenizerEntry): Promise<void> {
		if (this.entry?.id === entry.id && this.state !== "idle") return this.loading ?? Promise.resolve();
		this.end();
		this.entry = entry;
		this.restarts = 0;
		this.reason = undefined;
		const described = this.options.describe(entry);
		if (described.charsPerMs) this.charsPerMs = described.charsPerMs;
		this.loading = this.load(entry).finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	/** End the worker and every pending call (a family switch, or the session's end). */
	end(): void {
		this.generation++;
		this.clearTimer(this.loadTimer);
		this.loadTimer = undefined;
		const worker = this.worker;
		this.worker = undefined;
		if (worker) void Promise.resolve(worker.terminate()).catch(() => undefined);
		this.rejectAll(new Error("tokenizer worker ended"));
		this.state = "idle";
	}

	private async load(entry: TokenizerEntry): Promise<void> {
		const generation = this.generation;
		this.state = "loading";
		const file = await this.options.file(entry).catch((): TokenizerFile => ({ fallback: "download failed" }));
		if (generation !== this.generation) return;
		if ("fallback" in file) {
			this.settle("failed", entry, file.fallback);
			return;
		}
		const ok = await this.startAndLoad(entry, "bytes" in file ? file.bytes : undefined, generation);
		if (generation !== this.generation) return;
		if (ok) this.settle("ready", entry);
		else await this.failure("the tokenizer did not load", generation);
	}

	/** Start a worker and load `entry`; resolves true on ready. */
	private startAndLoad(entry: TokenizerEntry, bytes: Uint8Array | undefined, generation: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let worker: TokenizerWorker;
			try {
				worker = (this.options.startWorker ?? startTokenizerWorker)();
			} catch (error) {
				this.options.log?.(
					`tokenizer worker did not start: ${error instanceof Error ? error.message : String(error)}`,
				);
				resolve(false);
				return;
			}
			this.worker = worker;
			let settled = false;
			const done = (ok: boolean) => {
				if (settled) return;
				settled = true;
				this.clearTimer(this.loadTimer);
				this.loadTimer = undefined;
				resolve(ok);
			};
			worker.on("message", (reply) => {
				if (generation !== this.generation || worker !== this.worker) return;
				if (reply.type === "ready") {
					this.loadMs = reply.ms;
					if (reply.charsPerMs) this.charsPerMs = reply.charsPerMs;
					done(true);
				} else if (reply.type === "failed") {
					this.options.log?.(`tokenizer ${entry.id}: ${reply.reason}`);
					if (!settled) done(false);
					else void this.failure(reply.reason, generation);
				} else this.onReply(reply);
			});
			const crash = (why: string) => {
				if (generation !== this.generation || worker !== this.worker) return;
				this.options.log?.(`tokenizer worker ${why}`);
				if (!settled) done(false);
				else void this.failure(why, generation);
			};
			worker.on("error", (error) => crash(`error: ${error.message}`));
			worker.on("exit", (code) => crash(`exited (${code})`));
			// After the listeners: attaching a message listener refs the worker again.
			worker.unref?.();
			const size = bytes?.byteLength ?? 0;
			const watchdog =
				this.options.loadWatchdogMs?.(size) ?? Math.max(LOAD_WATCHDOG_MIN_MS, Math.ceil(size / 1_000_000) * 1000);
			this.loadTimer = this.setTimer(() => crash(`load took over ${watchdog} ms`), watchdog);
			const described = this.options.describe(entry);
			// Transferred, not copied: the main thread no longer holds the file.
			if (bytes) {
				const buffer = bytes.buffer as ArrayBuffer;
				worker.postMessage({ type: "load", entry: described, bytes: buffer }, [buffer]);
			} else worker.postMessage({ type: "load", entry: described });
		});
	}

	/** A crash, a hang or a failed load once ready: restart once, then fail for the session. */
	private async failure(why: string, generation: number): Promise<void> {
		if (generation !== this.generation) return;
		const entry = this.entry;
		const worker = this.worker;
		this.worker = undefined;
		this.generation++;
		const next = this.generation;
		if (worker) void Promise.resolve(worker.terminate()).catch(() => undefined);
		this.rejectAll(new Error(`tokenizer worker failed: ${why}`));
		if (!entry) return;
		if (this.restarts >= 1) {
			this.settle("failed", entry, "tokenizer worker failed");
			return;
		}
		this.restarts++;
		this.state = "loading";
		this.options.log?.(`tokenizer worker restarting (${why})`);
		this.loading = (async () => {
			const file = await this.options.file(entry).catch((): TokenizerFile => ({ fallback: "download failed" }));
			if (next !== this.generation) return;
			if ("fallback" in file) {
				this.settle("failed", entry, "tokenizer worker failed");
				return;
			}
			const ok = await this.startAndLoad(entry, "bytes" in file ? file.bytes : undefined, next);
			if (next !== this.generation) return;
			if (ok) this.settle("ready", entry);
			else {
				const failed = this.worker;
				this.worker = undefined;
				if (failed) void Promise.resolve(failed.terminate()).catch(() => undefined);
				this.settle("failed", entry, "tokenizer worker failed");
			}
		})().finally(() => {
			this.loading = undefined;
		});
		await this.loading;
	}

	private settle(state: "ready" | "failed", entry: TokenizerEntry, reason?: FallbackReason): void {
		this.state = state;
		this.reason = reason;
		this.options.onState?.(state, entry, reason);
	}

	private rejectAll(error: Error): void {
		this.clearTimer(this.progressTimer);
		this.progressTimer = undefined;
		for (const call of this.pending.values()) call.reject(error);
		this.pending.clear();
	}

	/** Milliseconds `chars` characters should take at the measured rate. */
	predictMs(chars: number): number {
		return chars / Math.max(1, this.charsPerMs);
	}

	/** The allowance for the worker's next answer while counting: a chunk's, or a load's after `building`. */
	private allowance(building: boolean): number {
		if (building) {
			const size = this.entry?.size ?? 0;
			return (
				this.options.loadWatchdogMs?.(size) ?? Math.max(LOAD_WATCHDOG_MIN_MS, Math.ceil(size / 1_000_000) * 1000)
			);
		}
		let longest = 0;
		for (const call of this.pending.values()) longest = Math.max(longest, call.longest);
		return Math.max(this.options.watchdogMs ?? WATCHDOG_MIN_MS, 10 * Math.max(CHUNK_MS, this.predictMs(longest)));
	}

	/** (Re)start the worker-level watchdog, or stop it when nothing is pending. */
	private armProgress(building = false): void {
		this.clearTimer(this.progressTimer);
		this.progressTimer = undefined;
		if (this.pending.size === 0) return;
		const ms = this.allowance(building);
		const generation = this.generation;
		this.progressTimer = this.setTimer(() => {
			this.progressTimer = undefined;
			if (this.pending.size === 0) return;
			void this.failure(`no answer from the worker in ${Math.round(ms)} ms while counting`, generation);
		}, ms);
	}

	private onReply(reply: WorkerReply): void {
		if (reply.type !== "chunk" && reply.type !== "done" && reply.type !== "building") return;
		const call = this.pending.get(reply.id);
		if (!call) return;
		if (reply.type === "building") {
			this.armProgress(true);
			return;
		}
		if (reply.type === "done") {
			this.pending.delete(reply.id);
			call.resolve();
			this.armProgress();
			return;
		}
		if (reply.ms > 5 && reply.chars > 0) this.charsPerMs = this.charsPerMs * 0.7 + (reply.chars / reply.ms) * 0.3;
		this.texts += reply.counts.length;
		try {
			call.onChunk?.({ from: reply.from, counts: reply.counts, ...(reply.bands ? { bands: reply.bands } : {}) });
		} catch (error) {
			this.options.log?.(`tokenizer count handler: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.armProgress();
	}

	/**
	 * Count `texts`. Chunks go to `onChunk` as they land; the promise resolves when every text is counted, and rejects
	 * when the worker fails or isn't ready.
	 */
	count(
		texts: string[],
		priority: "request" | "background",
		onChunk?: (chunk: CountChunk) => void,
	): { id: number; done: Promise<void> } {
		const id = this.nextId++;
		if (this.state !== "ready" || !this.worker) return { id, done: Promise.reject(new Error("tokenizer not ready")) };
		const worker = this.worker;
		const done = new Promise<void>((resolve, reject) => {
			const call: PendingCall = {
				id,
				texts,
				priority,
				onChunk,
				resolve,
				reject,
				longest: texts.reduce((most, t) => Math.max(most, t.length), 0),
			};
			const idle = this.pending.size === 0;
			this.pending.set(id, call);
			this.calls++;
			// The watchdog runs from the first pending call; later ones only lengthen its next allowance.
			if (idle) this.armProgress();
			worker.postMessage({ type: "count", id, priority, texts });
		});
		// A rejection nobody awaits is not an unhandled one.
		done.catch(() => undefined);
		return { id, done };
	}
}
