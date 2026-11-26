import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Tiktoken } from "js-tiktoken/lite";
import o200kRanks from "js-tiktoken/ranks/o200k_base";
import { describe, expect, it } from "vitest";
import { type CountChunk, TokenCounter, type TokenizerWorker, type WorkerReply } from "./counter.ts";
import { describeEntry } from "./describe.ts";
import type { TokenizerFile } from "./download.ts";
import { type TokenizerEntry, tokenizerEntry } from "./table.ts";

const O200K = tokenizerEntry("o200k") as TokenizerEntry;
const CL100K = tokenizerEntry("cl100k") as TokenizerEntry;
const GLM = tokenizerEntry("glm5") as TokenizerEntry;

/**
 * A fake worker: answers a load as `onLoad` says, and counts one token per character, in one chunk, unless `hang`.
 * Its `crash` sends an error, as a real worker's crash does.
 */
class FakeWorker implements TokenizerWorker {
	static started: FakeWorker[] = [];
	listeners: Record<string, Array<(value: never) => void>> = {};
	terminated = false;
	loads = 0;
	onLoad: "ready" | "failed" | "hang";
	hang: boolean;
	constructor(onLoad: "ready" | "failed" | "hang" = "ready", hang = false) {
		this.onLoad = onLoad;
		this.hang = hang;
		FakeWorker.started.push(this);
	}
	on(event: string, listener: (value: never) => void): unknown {
		const list = this.listeners[event] ?? [];
		list.push(listener);
		this.listeners[event] = list;
		return this;
	}
	emit(event: string, value: unknown): void {
		for (const l of this.listeners[event] ?? []) (l as (v: unknown) => void)(value);
	}
	postMessage(message: { type: string; id?: number; texts?: string[] }): void {
		queueMicrotask(() => {
			if (this.terminated) return;
			if (message.type === "load") {
				this.loads++;
				if (this.onLoad === "ready") this.emit("message", { type: "ready", id: "x", ms: 1 } satisfies WorkerReply);
				else if (this.onLoad === "failed") this.emit("message", { type: "failed", reason: "bad file" });
				return;
			}
			if (message.type === "count" && !this.hang) {
				const counts = message.texts!.map((t) => t.length);
				this.emit("message", { type: "chunk", id: message.id!, from: 0, counts, ms: 1, chars: counts.length });
				this.emit("message", { type: "done", id: message.id! });
			}
		});
	}
	crash(): void {
		this.emit("error", new Error("boom"));
	}
	terminate(): undefined {
		this.terminated = true;
		return undefined;
	}
}

function counter(workers: Array<() => FakeWorker>, file?: (e: TokenizerEntry) => Promise<TokenizerFile>) {
	let next = 0;
	const files: string[] = [];
	const states: string[] = [];
	const c = new TokenCounter({
		file: async (e) => {
			files.push(e.id);
			return file ? file(e) : { bytes: new Uint8Array(16) };
		},
		describe: describeEntry,
		startWorker: () => workers[Math.min(next++, workers.length - 1)](),
		onState: (state, _entry, reason) => states.push(reason ? `${state}: ${reason}` : state),
		loadWatchdogMs: () => 50,
		watchdogMs: 50,
	});
	return { c, files, states };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

describe("tokenizer counter: loads and counts", () => {
	it("loads, counts in chunks, and transfers the bytes", async () => {
		const { c, states } = counter([() => new FakeWorker()]);
		await c.use(GLM);
		expect(c.state).toBe("ready");
		expect(states).toEqual(["ready"]);
		const chunks: CountChunk[] = [];
		await c.count(["ab", "cde"], "request", (chunk) => chunks.push(chunk)).done;
		expect(chunks).toEqual([{ from: 0, counts: [2, 3] }]);
	});

	it("a family switch ends the old worker before the new one loads", async () => {
		const order: string[] = [];
		const make = (name: string) => () => {
			const w = new FakeWorker();
			const terminate = w.terminate.bind(w);
			w.terminate = () => {
				order.push(`end ${name}`);
				return terminate();
			};
			order.push(`start ${name}`);
			return w;
		};
		const { c } = counter([make("first"), make("second")]);
		await c.use(GLM);
		await c.use(O200K);
		expect(order).toEqual(["start first", "end first", "start second"]);
		expect(c.entry?.id).toBe("o200k");
	});

	it("a file that can't be had leaves the estimate, with its reason", async () => {
		const { c, states } = counter([() => new FakeWorker()], async () => ({ fallback: "offline" }));
		await c.use(GLM);
		expect(c.state).toBe("failed");
		expect(states).toEqual(["failed: offline"]);
		await expect(c.count(["a"], "request").done).rejects.toThrow("not ready");
	});
});

/**
 * A fake worker that answers counts slowly and in order, as the real one does: one chunk every `step` ms per text,
 * with an optional `building` before the first text that holds special-token text.
 */
class SlowWorker extends FakeWorker {
	queue: Array<{ id: number; texts: string[] }> = [];
	busy = false;
	readonly step: number;
	readonly buildMs: number;
	constructor(step: number, buildMs = 0) {
		super("ready");
		this.step = step;
		this.buildMs = buildMs;
	}
	override postMessage(message: { type: string; id?: number; texts?: string[] }): void {
		if (message.type !== "count") {
			super.postMessage(message);
			return;
		}
		this.queue.push({ id: message.id!, texts: message.texts! });
		void this.drain();
	}
	async drain(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		let built = false;
		while (this.queue.length > 0) {
			const job = this.queue.shift()!;
			for (let i = 0; i < job.texts.length; i++) {
				if (!built && this.buildMs > 0 && job.texts[i].includes("<|")) {
					built = true;
					this.emit("message", { type: "building", id: job.id });
					await new Promise((resolve) => setTimeout(resolve, this.buildMs));
				}
				await new Promise((resolve) => setTimeout(resolve, this.step));
				if (this.terminated) return;
				this.emit("message", {
					type: "chunk",
					id: job.id,
					from: i,
					counts: [job.texts[i].length],
					ms: 1,
					chars: 1,
				});
			}
			this.emit("message", { type: "done", id: job.id });
		}
		this.busy = false;
	}
}

describe("tokenizer counter: one watchdog for the worker, not one per call", () => {
	it("a call waiting in the worker's queue behind a long one isn't late while the worker works", async () => {
		// Each text takes 30 ms against a 50 ms watchdog: the second call waits about 600 ms for the first.
		const { c, states } = counter([() => new SlowWorker(30)]);
		await c.use(GLM);
		const first = c.count(
			Array.from({ length: 20 }, () => "abc"),
			"background",
		);
		const second = c.count(["queued"], "background");
		await Promise.all([first.done, second.done]);
		expect(c.restarts).toBe(0);
		expect(states).toEqual(["ready"]);
	});

	it("a request queued behind another call's build of the band's tokenizer gets a load's time", async () => {
		const workers: SlowWorker[] = [];
		const c = new TokenCounter({
			file: async () => ({ bytes: new Uint8Array(16) }),
			describe: describeEntry,
			startWorker: () => {
				const w = new SlowWorker(5, 300);
				workers.push(w);
				return w;
			},
			loadWatchdogMs: () => 2_000,
			watchdogMs: 50,
		});
		await c.use(GLM);
		const building = c.count(["plain", "<|im_end|> text"], "background");
		const request = c.count(["a request"], "request");
		await Promise.all([building.done, request.done]);
		expect(c.restarts).toBe(0);
		expect(workers).toHaveLength(1);
	});
});

describe("tokenizer counter: failures, the watchdogs and the one restart", () => {
	it("a crash mid-count rejects the pending call, and the worker restarts once, loading the file again", async () => {
		const first = new FakeWorker("ready", true);
		const { c, files, states } = counter([() => first, () => new FakeWorker()]);
		await c.use(GLM);
		const call = c.count(["abc"], "request");
		first.crash();
		await expect(call.done).rejects.toThrow("tokenizer worker failed");
		await settle();
		expect(c.state).toBe("ready");
		expect(c.restarts).toBe(1);
		// The bytes were transferred to the first worker, so the restart reads and checks the file again.
		expect(files).toEqual(["glm5", "glm5"]);
		expect(states).toEqual(["ready", "ready"]);
		await c.count(["abc"], "request").done;
	});

	it("a second crash after the restart fails the tokenizer for the session", async () => {
		const first = new FakeWorker();
		const second = new FakeWorker();
		const { c, states } = counter([() => first, () => second]);
		await c.use(GLM);
		first.crash();
		await settle();
		expect(c.state).toBe("ready");
		second.crash();
		await settle();
		expect(c.state).toBe("failed");
		expect(c.reason).toBe("tokenizer worker failed");
		expect(states.at(-1)).toBe("failed: tokenizer worker failed");
	});

	it("a hung count (the watchdog) counts as a crash", async () => {
		const { c } = counter([() => new FakeWorker("ready", true), () => new FakeWorker()]);
		await c.use(GLM);
		await expect(c.count(["abc"], "request").done).rejects.toThrow("no answer from the worker");
		await settle();
		expect(c.state).toBe("ready");
		expect(c.restarts).toBe(1);
	});

	it("a hung load gets its own watchdog: restarted once, then failed", async () => {
		const { c, states } = counter([() => new FakeWorker("hang"), () => new FakeWorker("hang")]);
		await c.use(GLM);
		await settle();
		expect(c.state).toBe("failed");
		expect(states).toEqual(["failed: tokenizer worker failed"]);
	});

	it("a restart that fails to load fails the tokenizer", async () => {
		const first = new FakeWorker();
		const { c } = counter([() => first, () => new FakeWorker("failed")]);
		await c.use(GLM);
		first.crash();
		await settle();
		expect(c.state).toBe("failed");
	});

	it("the deadline is predicted from the family's rate, then from the measured one", () => {
		const { c } = counter([() => new FakeWorker()]);
		void c.use(GLM);
		// GLM's prior: 190 tokens a millisecond, at 4 characters a token.
		expect(c.charsPerMs).toBe(760);
		expect(Math.round(c.predictMs(76_000))).toBe(100);
		void c.use(tokenizerEntry("gemma4") as TokenizerEntry);
		expect(Math.round(c.predictMs(76_000))).toBe(760);
	});
});

/** The longest the main thread was blocked while `run` ran, by a 1 ms timer and the event-loop histogram. */
async function longestBlock(run: () => Promise<void>): Promise<number> {
	const histogram = monitorEventLoopDelay({ resolution: 1 });
	histogram.enable();
	let last = performance.now();
	let worst = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		worst = Math.max(worst, now - last);
		last = now;
	}, 1);
	try {
		await run();
	} finally {
		clearInterval(timer);
		histogram.disable();
	}
	return Math.max(worst, histogram.max / 1e6);
}

function prose(chars: number, seed: number): string {
	const words = [
		"the",
		"context",
		"engine",
		"counts",
		"every",
		"request",
		"with",
		"its",
		"tokenizer",
		"and",
		"a",
		"window",
	];
	let s = "";
	let x = seed;
	while (s.length < chars) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		s += `${words[x % words.length]}${x % 17 === 0 ? ".\n" : " "}`;
	}
	return s.slice(0, chars);
}

describe("tokenizer counter: the real worker", { timeout: 120_000 }, () => {
	const real = () => new TokenCounter({ file: async () => ({ bundled: true }), describe: describeEntry });

	it("counts with o200k and cl100k, and a request count jumps a background one", async () => {
		const c = real();
		await c.use(O200K);
		expect(c.state).toBe("ready");
		const counts: number[] = [];
		await c.count(["Hello world", "x".repeat(10_000)], "request", (chunk) => {
			chunk.counts.forEach((n, i) => {
				counts[chunk.from + i] = n;
			});
		}).done;
		// A long run of one letter is merged in the worker's heap: js-tiktoken's count, without its quadratic time.
		expect(counts).toEqual([2, 1250]);
		const order: string[] = [];
		const background = c.count(
			Array.from({ length: 200 }, (_, i) => prose(20_000, i)),
			"background",
		);
		background.done.then(() => order.push("background"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		await c.count(["a request"], "request").done.then(() => order.push("request"));
		await background.done;
		expect(order).toEqual(["request", "background"]);
		await c.use(CL100K);
		const got: number[] = [];
		await c.count(["Hello world"], "request", (chunk) => got.push(...chunk.counts)).done;
		expect(got).toEqual([2]);
		c.end();
	});

	it("a piece over 64 characters counts as js-tiktoken counts it, token for token", async () => {
		const c = real();
		await c.use(O200K);
		// Shapes that counting in slices of 64 got wrong by 9% to 36%, and runs of a multi-byte character and of emoji.
		const texts = [
			`section 1\n${"-=".repeat(35)}\n`.repeat(40),
			`Output:\r\n${"\r\n".repeat(600)}Done.\r\n`,
			"abcdefghij".repeat(100),
			`${"\u2026".repeat(200)}\n${"\u{1F642}".repeat(100)}<|endoftext|>${"y".repeat(300)}`,
		];
		const counts: number[] = [];
		await c.count(texts, "request", (chunk) => {
			chunk.counts.forEach((n, i) => {
				counts[chunk.from + i] = n;
			});
		}).done;
		const reference = new Tiktoken(o200kRanks);
		expect(counts).toEqual(texts.map((t) => reference.encode(t, "all").length));
		c.end();
	});

	it("two background calls, the first about 4 MB, are both fulfilled with no restart", async () => {
		const c = real();
		await c.use(O200K);
		const big = c.count(
			Array.from({ length: 1_600 }, (_, i) => prose(2_500, i)),
			"background",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const small = c.count(["one more message"], "background");
		await Promise.all([big.done, small.done]);
		expect(c.restarts).toBe(0);
		expect(c.state).toBe("ready");
		c.end();
	});

	it("a process that never ends its counter still exits: the worker is unrefed after its listeners", async () => {
		const dir = mkdtempSync(join(tmpdir(), "penpi-unref-"));
		const script = join(dir, "never-ends.mts");
		const here = dirname(fileURLToPath(import.meta.url));
		writeFileSync(
			script,
			`import { TokenCounter } from ${JSON.stringify(join(here, "counter.ts"))};
import { describeEntry } from ${JSON.stringify(join(here, "describe.ts"))};
import { tokenizerEntry } from ${JSON.stringify(join(here, "table.ts"))};
// The host's own handles keep the process up while it waits (in Pi, the agent loop's); the worker doesn't.
const host = setInterval(() => undefined, 1000);
const c = new TokenCounter({ file: async () => ({ bundled: true }), describe: describeEntry });
await c.use(tokenizerEntry("o200k"));
await c.count(["Hello world"], "request").done;
console.log(c.state);
clearInterval(host);
`,
		);
		const started = Date.now();
		const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
			cwd: join(here, "../../../../.."),
			timeout: 60_000,
			encoding: "utf8",
		});
		rmSync(dir, { recursive: true, force: true });
		expect(out.trim()).toBe("ready");
		// Loaded and counted, then exited on its own: no end(), no session_shutdown.
		expect(Date.now() - started).toBeLessThan(30_000);
	});

	it("a deadline keeps the chunks already counted; the rest still lands", async () => {
		const c = real();
		await c.use(O200K);
		const texts = Array.from({ length: 400 }, (_, i) => prose(10_000, i));
		let landed = 0;
		const call = c.count(texts, "background", (chunk) => {
			landed += chunk.counts.length;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		const atDeadline = landed;
		expect(atDeadline).toBeGreaterThan(0);
		expect(atDeadline).toBeLessThan(texts.length);
		await call.done;
		expect(landed).toBe(texts.length);
		c.end();
	});

	it("the event-loop bar: under 100 ms during a load, a 1M-token count, a family switch, and a request while busy", async () => {
		const c = real();
		const load = await longestBlock(() => c.use(O200K));
		// About 1M tokens, in 1,600 messages of 2,500 characters.
		const texts = Array.from({ length: 1_600 }, (_, i) => prose(2_500, i));
		const count = await longestBlock(() => c.count(texts, "background").done);
		const busy = await longestBlock(async () => {
			const background = c.count(texts, "background");
			await new Promise((resolve) => setTimeout(resolve, 20));
			await c.count(["a request while the worker is busy"], "request").done;
			await background.done;
		});
		const swap = await longestBlock(() => c.use(CL100K));
		c.end();
		for (const [what, ms] of Object.entries({ load, count, busy, swap })) expect(ms, what).toBeLessThan(100);
	});
});
