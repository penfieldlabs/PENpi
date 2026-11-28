/**
 * The tokenizer worker (0.9.0, design section 2). Plain JS, started by tokenizers/counter.ts (startTokenizerWorker),
 * in the literal form the import check walks. It never touches the network, the file system or
 * crypto (scripts/check-extension-graph.mjs enforces it): the main thread reads the tokenizer file, checks its size
 * and SHA-256 on exactly those bytes, and transfers that buffer here, so what is loaded is what was hashed.
 *
 * Messages in:
 *   { type: "load", entry: { id, loader, pattern?, specials? }, bytes? }  bytes: the verified file's ArrayBuffer,
 *     transferred (none for the bundled o200k and cl100k). Answers { type: "ready", id, ms } or
 *     { type: "failed", reason }.
 *   { type: "count", id, priority: "request" | "background", texts }  answers one { type: "chunk", id, from, counts,
 *     bands?, ms, chars } per chunk, then { type: "done", id }. A chunk is about 50 ms of counting at the rate measured
 *     so far. Request counts go ahead of background ones: the queue is read again between chunks.
 * One tokenizer per worker: a family switch ends this worker and starts another.
 *
 * The band (design section 1): text holding the file's own added-token strings, or a generic special-token pattern,
 * is counted twice, each such string as one token and as text, and the chunk carries both as `bands`: [index, as
 * text]. On a Hugging Face file "as text" is a second instance with its added tokens dropped, built only when such a
 * string first occurs; on js-tiktoken it is encode(text, [], []).
 */
import { parentPort } from "node:worker_threads";
import { Tokenizer } from "@huggingface/tokenizers";
import { Tiktoken } from "js-tiktoken/lite";

/** About this long per chunk. */
const CHUNK_MS = 50;
/** Characters per millisecond before anything is measured; the main thread sends the family's prior. */
let charsPerMs = 300;

/** Specials and tags that look like a chat template's, in any family's text. */
const GENERIC =
	/<\|[^|\s]{1,64}\|>|<｜[^｜\s]{1,64}｜>|<\/?(?:think|thinking|answer|reasoning|tool_call|tool_calls|tool_response|tool_result|function_call|arg_key|arg_value|observation|im_start|im_end|start_of_turn|end_of_turn|bos|eos|s|unk|pad)>|\[\/?(?:INST|SYSTEM_PROMPT|AVAILABLE_TOOLS|TOOL_CALLS|TOOL_RESULTS|TOOL_CONTENT|THINK|BOS|EOS|EOT|UNK|PAD)\]/;

let tokenizer;
let entryId;
/** The count being worked on, for the `building` message. */
let current;
const queue = [];
let busy = false;

function escape(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Kimi's tiktoken.model: one "base64 rank" pair per line, as js-tiktoken's ranks with one rank per line. */
function tiktokenRanks(bytes, pattern, specials) {
	const lines = new TextDecoder().decode(bytes).split("\n");
	const out = [];
	for (const line of lines) {
		if (!line) continue;
		const space = line.indexOf(" ");
		out.push(`! ${line.slice(space + 1)} ${line.slice(0, space)}`);
	}
	return { pat_str: pattern, special_tokens: specials ?? {}, bpe_ranks: out.join("\n") };
}

/** A piece of the split pattern longer than this is merged by mergedTokens (below), not by js-tiktoken. */
const LONG = 64;
/** A piece that is all whitespace. */
const WHITESPACE = /^\s+$/u;

const bytesOf = new TextEncoder();
/** Whether heap entry a ([rank, start, version]) comes before b: the lower rank, then the leftmost. */
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
function heapPush(heap, x) {
	heap.push(x);
	let i = heap.length - 1;
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (!before(heap[i], heap[p])) break;
		[heap[i], heap[p]] = [heap[p], heap[i]];
		i = p;
	}
}
function heapPop(heap) {
	const top = heap[0];
	const last = heap.pop();
	if (heap.length > 0) {
		heap[0] = last;
		for (let i = 0; ; ) {
			const l = 2 * i + 1;
			const r = l + 1;
			let m = i;
			if (l < heap.length && before(heap[l], heap[m])) m = l;
			if (r < heap.length && before(heap[r], heap[m])) m = r;
			if (m === i) break;
			[heap[i], heap[m]] = [heap[m], heap[i]];
			i = m;
		}
	}
	return top;
}

/**
 * The tokens of one piece of the split pattern, as js-tiktoken's byte-pair merge makes them (the lowest-ranked adjacent
 * pair first, the leftmost on a tie), with the pairs kept in a heap instead of rescanned after every merge.
 */
function mergedTokens(rankMap, piece) {
	const bytes = bytesOf.encode(piece);
	const n = bytes.length;
	if (n === 1 || rankMap.has(bytes.join(","))) return 1;
	// The parts as a linked list over their start offsets; end[i] is -1 once part i is merged into the one before it.
	const end = new Int32Array(n);
	const next = new Int32Array(n);
	const prev = new Int32Array(n);
	const version = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		end[i] = i + 1;
		next[i] = i + 1 < n ? i + 1 : -1;
		prev[i] = i - 1;
	}
	const rank = (i) => (next[i] < 0 ? undefined : rankMap.get(bytes.subarray(i, end[next[i]]).join(",")));
	const heap = [];
	for (let i = 0; i < n - 1; i++) {
		const r = rank(i);
		if (r !== undefined) heapPush(heap, [r, i, 0]);
	}
	let parts = n;
	while (heap.length > 0) {
		const [r, i, v] = heapPop(heap);
		if (v !== version[i] || end[i] < 0 || rank(i) !== r) continue;
		const j = next[i];
		end[i] = end[j];
		next[i] = next[j];
		if (next[j] >= 0) prev[next[j]] = i;
		end[j] = -1;
		version[j]++;
		version[i]++;
		parts--;
		const ri = rank(i);
		if (ri !== undefined) heapPush(heap, [ri, i, version[i]]);
		const p = prev[i];
		if (p >= 0) {
			version[p]++;
			const rp = rank(p);
			if (rp !== undefined) heapPush(heap, [rp, p, version[p]]);
		}
	}
	return parts;
}

/**
 * A js-tiktoken tokenizer: specials as one token, and as text.
 *
 * js-tiktoken merges each piece of its split pattern in time quadratic in the piece's length: 8,000 "x" take 20 s,
 * where 40,000 characters of base64, which the pattern splits, take 0.1 s. So a text longer than LONG is split by the
 * pattern itself, which finds every long piece whatever it holds (o200k's punctuation pieces take a tail of line
 * breaks and slashes, so "//\n" repeated is one piece): the text between long pieces is encoded whole, as before,
 * and each long piece is merged by mergedTokens, in about n log n: 30,000 "x" take about 0.3 s. The count is
 * js-tiktoken's, token for token.
 */
function fromTiktoken(ranks) {
	const encoder = new Tiktoken(ranks);
	const pattern = new RegExp(ranks.pat_str, "gu");
	const own = Object.keys(ranks.special_tokens ?? {});
	const trigger = own.length > 0 ? new RegExp(own.map(escape).join("|")) : undefined;
	const specials = own.length > 0 ? new RegExp(own.map(escape).join("|"), "g") : undefined;
	// Every piece as the whole text's matches make it. A slice encoded on its own is split again, and a run of
	// whitespace that ends a slice before a long piece would come out one piece where the whole text has two
	// (\s+(?!\S) takes all of it at the end of a string): so each slice ends after its last piece that isn't
	// whitespace, and the whitespace pieces after it, up to the long piece, are counted one by one.
	const split = (text, allowed) => {
		let n = 0;
		let from = 0;
		let solid = 0;
		const spaces = [];
		for (const m of text.matchAll(pattern)) {
			const piece = m[0];
			if (piece.length > LONG) {
				if (solid > from) n += encoder.encode(text.slice(from, solid), allowed, []).length;
				for (const s of spaces) n += mergedTokens(encoder.rankMap, s);
				n += mergedTokens(encoder.rankMap, piece);
				from = solid = m.index + piece.length;
				spaces.length = 0;
			} else if (WHITESPACE.test(piece)) spaces.push(piece);
			else {
				solid = m.index + piece.length;
				spaces.length = 0;
			}
		}
		// The last slice ends where the text does, as it does in the whole text.
		if (from < text.length) n += encoder.encode(text.slice(from), allowed, []).length;
		return n;
	};
	const count = (text, allowed) => {
		// A text this short holds no long piece.
		if (text.length <= LONG) return encoder.encode(text, allowed, []).length;
		// Specials first, as encode does, so a long run never swallows one.
		if (allowed !== "all" || !specials) return split(text, []);
		let n = 0;
		let last = 0;
		for (const m of text.matchAll(specials)) {
			if (m.index > last) n += split(text.slice(last, m.index), []);
			n++;
			last = m.index + m[0].length;
		}
		if (last < text.length) n += split(text.slice(last), []);
		return n;
	};
	return { count: (text) => count(text, "all"), asText: (text) => count(text, []), trigger };
}

/**
 * A Hugging Face tokenizer.json: added tokens matched as one token, and, for the band, a copy without them. Building
 * the copy parses the file again, about as long as the load, so the worker says so first (`building`), and the main
 * thread's watchdog allows a load's time.
 */
function fromHf(bytes) {
	const json = JSON.parse(new TextDecoder().decode(bytes));
	const encoder = new Tokenizer(json, {});
	const own = (json.added_tokens ?? []).map((t) => t.content).filter((c) => typeof c === "string" && c.length > 1);
	const trigger = own.length > 0 ? new RegExp(own.map(escape).join("|")) : undefined;
	let plain;
	return {
		count: (text) => encoder.encode(text, { add_special_tokens: false }).ids.length,
		asText: (text) => {
			if (!plain) {
				parentPort.postMessage({ type: "building", id: current });
				const copy = JSON.parse(new TextDecoder().decode(bytes));
				copy.added_tokens = [];
				plain = new Tokenizer(copy, {});
			}
			return plain.encode(text, { add_special_tokens: false }).ids.length;
		},
		trigger,
	};
}

async function load(message) {
	const started = performance.now();
	const { entry } = message;
	if (entry.id === "o200k") tokenizer = fromTiktoken((await import("js-tiktoken/ranks/o200k_base")).default);
	else if (entry.id === "cl100k") tokenizer = fromTiktoken((await import("js-tiktoken/ranks/cl100k_base")).default);
	else if (entry.loader === "tiktoken")
		tokenizer = fromTiktoken(tiktokenRanks(new Uint8Array(message.bytes), entry.pattern, entry.specials));
	else if (entry.loader === "hf") tokenizer = fromHf(new Uint8Array(message.bytes));
	else throw new Error(`no loader for ${entry.id}`);
	if (entry.charsPerMs > 0) charsPerMs = entry.charsPerMs;
	entryId = entry.id;
	// One count, so the first request doesn't pay the library's own warm-up.
	tokenizer.count("warm up");
	return performance.now() - started;
}

/** The next queued count: request priority first, then the oldest. */
function next() {
	const at = queue.findIndex((job) => job.priority === "request");
	return at >= 0 ? queue.splice(at, 1)[0] : queue.shift();
}

function band(text) {
	return GENERIC.test(text) || (tokenizer.trigger?.test(text) ?? false);
}

async function drain() {
	if (busy) return;
	busy = true;
	try {
		while (queue.length > 0) {
			const job = next();
			current = job.id;
			const budget = Math.max(1, charsPerMs * CHUNK_MS);
			const started = performance.now();
			const from = job.at;
			const counts = [];
			const bands = [];
			let chars = 0;
			while (job.at < job.texts.length && (chars === 0 || chars < budget)) {
				const text = job.texts[job.at];
				counts.push(tokenizer.count(text));
				if (band(text)) bands.push([job.at, tokenizer.asText(text)]);
				chars += text.length;
				job.at++;
			}
			const ms = performance.now() - started;
			// The rate this machine counts at, from chunks long enough to time.
			if (ms > 5 && chars > 0) charsPerMs = charsPerMs * 0.7 + (chars / ms) * 0.3;
			parentPort.postMessage({ type: "chunk", id: job.id, from, counts, ...(bands.length ? { bands } : {}), ms, chars });
			if (job.at < job.texts.length) queue.unshift(job);
			else parentPort.postMessage({ type: "done", id: job.id });
			// Let a request count that arrived meanwhile in before the next chunk.
			await new Promise((resolve) => setImmediate(resolve));
		}
	} finally {
		busy = false;
	}
}

parentPort.on("message", async (message) => {
	if (message.type === "load") {
		try {
			const ms = await load(message);
			parentPort.postMessage({ type: "ready", id: entryId, ms, charsPerMs });
		} catch (error) {
			parentPort.postMessage({ type: "failed", reason: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (message.type === "count") {
		if (!tokenizer) {
			parentPort.postMessage({ type: "failed", reason: "count before load" });
			return;
		}
		queue.push({ id: message.id, priority: message.priority, texts: message.texts, at: 0 });
		drain();
	}
});
