// The floor sweep's cases (floor-sweep.test.ts) counted with Claude's own tokenizer, through Anthropic's token counter
// (POST /v1/messages/count_tokens), and their real tokens over the growth check's floor (textTokensFloor), per model.
// ADR 0033 cites what it measured. Counting is free, but it needs an Anthropic API key. The full guide is
// floor-sweep-claude.md beside this file.
//
// From the repository root, with the Node version the repository's `engines` field sets (it imports the TypeScript
// sources directly):
//
//   ANTHROPIC_API_KEY=... node packages/coding-agent/test/suite/context-engine/floor-sweep-claude.mjs <phase>
//
// Phases:
//   key        whether ANTHROPIC_API_KEY is set (no network)
//   overhead   each model's request overhead, from single lowercase letters (one token each for Claude)
//   probe      overhead, then every 64th case of the sweep on each model; models whose counts are identical on all of
//              them form a group (OUT/probe/groups.json)
//   sweep      the sweep on MODELS (default: the first model of each probe group; "all" for every model)
//   report     the reports again from what is counted, with the checkout's floor (no network)
//   export     the full sweep's counts, one column per group of models that count it alike, to claude-counts.txt
//              beside this file (COUNTS_FILE), which claude-counts.test.ts re-prices offline (no network)
//   billing    an optional paid check that real requests bill what the counter counts: a few short texts per model,
//              each counted free and then sent to POST /v1/messages with max_tokens 1. Without PAID_CHECK=1 it only
//              counts them and prints what sending would cost; with it, it sends them (well under a cent a model).
//              MODELS default: the first model of each probe group, else claude-haiku-4-5 and claude-haiku-5-5.
//
// Environment (all optional but the key):
//   ANTHROPIC_API_KEY  the key; never printed, logged or written
//   MODELS     comma-separated model ids (default: every Claude id in packages/ai/src/providers/data/anthropic.json)
//   OUT        output directory (default: floor-sweep-claude in the system's temp directory)
//   BASE_URL   default https://api.anthropic.com
//   RATE       requests a minute at most (default 1000)          CONC   requests in flight at most (default 16)
//   FLOOR_SWEEP_FULL  "0" for the default sweep (20,751 cases) instead of the full one (24,321); default "1"
//   LIMIT      only the first LIMIT cases of the sweep (a quick try)
//   PAID_CHECK "1" to let the billing phase send its paid requests; off otherwise
//   COUNTS_FILE  where export writes (default: claude-counts.txt beside this file)
//
// How a case is counted. Each case is one user message with one text block. The endpoint drops line feeds at the end
// of a text ("hello" and "hello" plus breaks count the same) and refuses a text that is whitespace only, so a text
// whose trailing run of whitespace and control characters holds a line feed, or that is refused as whitespace only, is
// sent with an "a" after it and counted 1 less (marked "suffixed"). A letter at both ends is no good: on the 4.5 and
// 4.6 models a leading letter changes how a run of capitals splits. A lone surrogate is not valid in the request's
// JSON, so it is sent as U+FFFD, as a UTF-8 client would send it (marked "fffd"); the floor is that of the case as it
// is. A case's real tokens are the count less the model's overhead.
//
// Every count is appended to OUT/<phase>/<model>.jsonl as it arrives, with a hash of the case's text, and a rerun
// skips what is there for the same text, so a stopped run resumes and a changed case is counted again. A 429 waits as long as its retry-after asks; a 5xx or network error is retried up to 8 times. The
// reports are OUT/<phase>/<model>.report.json ({ name, chars, floor, real, ratio, mode }, lowest ratio first) and
// OUT/summary.json; the lines printed name the cases below 0.25 of the floor.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const phase = process.argv[2];
const env = process.env;
const OUT = resolve(env.OUT ?? join(tmpdir(), "floor-sweep-claude"));
const BASE_URL = (env.BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
const RATE = Number(env.RATE ?? 1000);
const CONC = Number(env.CONC ?? 16);
const FULL = (env.FLOOR_SWEEP_FULL ?? "1") === "1";
const LIMIT = env.LIMIT ? Number(env.LIMIT) : undefined;
const VERSION = "2023-06-01";
const PROBE_STEP = 64;
const LETTERS = ["a", "b", "e", "k", "m", "x"];

/** Every error message with the key, if it is in there, replaced by "<key>", before it is stored or printed. */
const secrets = [env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY?.trim()].filter((k) => k && k.length >= 8);
const scrub = (text) => secrets.reduce((t, k) => t.split(k).join("<key>"), String(text));

const log = (line) => {
	const stamped = `${new Date().toISOString()} ${scrub(line)}`;
	console.log(stamped);
	mkdirSync(OUT, { recursive: true });
	appendFileSync(join(OUT, "run.log"), `${stamped}\n`);
};

// ---------------------------------------------------------------- cases and models
/** The sweep as floor-sweep.test.ts builds it, each case keyed by its name ("#2", "#3" on a repeat), built lazily. */
async function sweepCases() {
	const C = await import(join(here, "floor-sweep-cases.ts"));
	const sizes = FULL ? C.SWEEP_SIZES : C.SWEEP_SIZES.filter((s) => s <= 10_000);
	const list = [
		...C.recheckCases(),
		...C.thirdRecheckCases(),
		...C.fourthRecheckCases(),
		...C.fifthRecheckCases(),
		...C.namedCases(),
		...C.whitespaceCases(),
		...C.markerLineCases(),
		...C.markerPlaceCases(),
		...C.nonAsciiRunCases(),
		...C.generatedCases(sizes),
	];
	const seen = new Map();
	return list.map((c) => {
		const n = (seen.get(c.name) ?? 0) + 1;
		seen.set(c.name, n);
		return { key: n === 1 ? c.name : `${c.name}#${n}`, text: c.text };
	});
}

function allModels() {
	const data = JSON.parse(readFileSync(join(root, "packages/ai/src/providers/data/anthropic.json"), "utf8"));
	return [...new Set(Object.values(data["anthropic-messages"]).map((m) => m.id))].filter((id) =>
		id.startsWith("claude-"),
	);
}

// ---------------------------------------------------------------- requests, at RATE a minute and CONC in flight
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
let pausedUntil = 0;
const stats = { requests: 0, r429: 0, retries: 0 };

class Fatal extends Error {}

async function slot() {
	for (;;) {
		const now = Date.now();
		const at = Math.max(nextSlot, pausedUntil);
		if (at <= now) {
			nextSlot = Math.max(nextSlot, now) + 60_000 / RATE;
			return;
		}
		await sleep(at - now);
	}
}

/** One count: { n } or { err, status }; throws Fatal on a key or permission error. */
async function countOnce(key, model, text) {
	const r = await post(key, "/v1/messages/count_tokens", {
		model,
		messages: [{ role: "user", content: [{ type: "text", text }] }],
	});
	return r.body ? { n: r.body.input_tokens } : r;
}

/** One request to the API, with the rate cap, the 429 wait and retries: { body } or { err, status }. */
async function post(key, path, payload) {
	let attempt = 0;
	const model = payload.model;
	for (;;) {
		await slot();
		stats.requests++;
		let res;
		let body;
		try {
			res = await fetch(`${BASE_URL}${path}`, {
				method: "POST",
				headers: { "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			body = await res.json().catch(() => ({}));
		} catch (e) {
			// A TypeError with no cause is thrown before the request is sent (an invalid header, say): retrying cannot
			// help. A network failure is a TypeError ("fetch failed") with the reason as its cause.
			if (e instanceof TypeError && e.cause === undefined) throw new Fatal(`request not sent: ${scrub(e.message)}`);
			res = undefined;
			body = { error: { message: String(e?.message ?? e) } };
		}
		const status = res?.status ?? 0;
		if (status === 200 && (Number.isInteger(body.input_tokens) || Number.isInteger(body.usage?.input_tokens)))
			return { body };
		const message = scrub(body?.error?.message ?? "");
		if (status === 401 || status === 403) throw new Fatal(`HTTP ${status}: ${body?.error?.type ?? ""} (stopping)`);
		if (status === 429) {
			stats.r429++;
			const after = Number(res.headers.get("retry-after"));
			const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 10_000;
			pausedUntil = Math.max(pausedUntil, Date.now() + wait);
			log(`429 on ${model}: waiting ${Math.round(wait / 1000)} s as the response asks`);
			continue;
		}
		if (status === 0 || status >= 500) {
			attempt++;
			stats.retries++;
			if (attempt > 8) return { err: `HTTP ${status} after 8 retries: ${message}`, status };
			await sleep(Math.min(60_000, 1000 * 2 ** attempt));
			continue;
		}
		return { err: `HTTP ${status}: ${message}`, status };
	}
}

const TRAILING_BREAK = /\n[\s\p{Cc}]*$/u;

/** A case's count, with the suffix and U+FFFD rules (see the top of the file). */
async function countCase(key, model, text) {
	const sent = text.isWellFormed() ? text : text.toWellFormed();
	const marks = sent === text ? [] : ["fffd"];
	const suffixed = async () => {
		const r = await countOnce(key, model, `${sent}a`);
		return r.n === undefined ? r : { n: r.n, mode: [...marks, "suffixed"].join(",") };
	};
	if (TRAILING_BREAK.test(sent)) return suffixed();
	const r = await countOnce(key, model, sent);
	if (r.status === 400 && /whitespace|empty/i.test(r.err)) return suffixed();
	return r.n === undefined || marks.length === 0 ? r : { n: r.n, mode: marks.join(",") };
}

// ---------------------------------------------------------------- results on disk
/**
 * Each case's row in a results file: the last count, or, for a case with no count, its last error. A case that has
 * an error and no count is counted again on a rerun, and once it is counted, its error rows are no longer read.
 */
/** The first 16 hex digits of a text's SHA-256: a row's count holds for the text it was counted for only. */
const textHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Whether a row was counted for this text. A row from before the hash was kept is checked by its length only. */
const sameText = (r, hash, chars) => (r.h !== undefined ? r.h === hash : r.chars === chars);

function readDone(file) {
	const done = new Map();
	if (!existsSync(file)) return done;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const r = JSON.parse(line);
			if (r.n !== undefined || done.get(r.k)?.n === undefined) done.set(r.k, r);
		} catch {
			// A line cut by a stop: counted again.
		}
	}
	return done;
}

/** Counts the cases of one model that its file holds no count for yet (none, or only an error). */
async function countModel(key, model, cases, file) {
	const done = readDone(file);
	for (const [k, r] of done) if (r.n === undefined) done.delete(k);
	const todo = cases.filter((c) => {
		const r = done.get(c.key);
		if (!r) return true;
		const text = c.text();
		return !sameText(r, textHash(text), text.length);
	});
	if (todo.length === 0) return;
	log(`${model}: ${todo.length} to count, ${cases.length - todo.length} already counted`);
	let i = 0;
	let counted = 0;
	const worker = async () => {
		while (i < todo.length) {
			const c = todo[i++];
			const text = c.text();
			const r = await countCase(key, model, text);
			const row =
				r.n !== undefined ? { k: c.key, n: r.n, ...(r.mode ? { mode: r.mode } : {}) } : { k: c.key, err: r.err };
			appendFileSync(file, `${JSON.stringify({ ...row, chars: text.length, h: textHash(text) })}\n`);
			if (++counted % 1000 === 0) log(`${model}: ${counted} of ${todo.length}`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));
}

// ---------------------------------------------------------------- overhead
/** A model's overhead: a lowercase letter's count less 1. The letters must agree. */
function settle(o) {
	const counts = o.per.filter((p) => p.count !== undefined).map((p) => p.count);
	return { ...o, overhead: counts[0] - 1, fixed: counts.length === LETTERS.length && new Set(counts).size === 1 };
}

async function overhead(key, model) {
	const file = join(OUT, "overhead", `${model}.json`);
	if (existsSync(file)) {
		const o = JSON.parse(readFileSync(file, "utf8"));
		// A file with a letter that was not counted is counted again.
		if (o.per?.every((p) => p.count !== undefined)) return settle(o);
	}
	const per = [];
	for (const text of LETTERS) {
		const r = await countOnce(key, model, text);
		if (r.n === undefined) {
			if (r.status === 404) return { model, unavailable: r.err };
			// No overhead without every letter: nothing is written, so a rerun counts the letters again.
			return { model, unavailable: `letter ${JSON.stringify(text)} not counted: ${r.err}` };
		}
		per.push({ text, count: r.n });
	}
	const result = settle({ model, per });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(result, null, 1));
	return result;
}

// ---------------------------------------------------------------- reports
function reportModel(phaseName, model, cases, floorOf) {
	const file = join(OUT, phaseName, `${model}.jsonl`);
	const ohFile = join(OUT, "overhead", `${model}.json`);
	if (!existsSync(file) || !existsSync(ohFile)) return undefined;
	const oh = settle(JSON.parse(readFileSync(ohFile, "utf8")));
	const done = readDone(file);
	const rows = [];
	const errors = [];
	for (const c of cases) {
		const r = done.get(c.key);
		if (!r) continue;
		// A count for the case's text as it was before a change is not counted.
		if (r.n !== undefined) {
			const text = c.text();
			if (!sameText(r, textHash(text), text.length)) continue;
		}
		if (r.err) {
			errors.push({ name: c.key, err: scrub(r.err) });
			continue;
		}
		const real = r.n - oh.overhead - (r.mode?.includes("suffixed") ? 1 : 0);
		const floor = floorOf(c);
		// A case Claude counts at 0 whose floor is 0 reads 1.
		const ratio = floor === 0 ? (real <= 0 ? 1 : Number.POSITIVE_INFINITY) : real / floor;
		rows.push({ name: c.key, chars: r.chars, floor, real, ratio, ...(r.mode ? { mode: r.mode } : {}) });
	}
	rows.sort((a, b) => a.ratio - b.ratio);
	writeFileSync(join(OUT, phaseName, `${model}.report.json`), JSON.stringify(rows));
	const below = (line) => rows.filter((r) => r.ratio < line);
	const summary = {
		model,
		counted: rows.length,
		of: cases.length,
		refused: errors.length,
		overhead: oh.overhead,
		lettersAgree: oh.fixed,
		below25: below(0.25).length,
		below50: below(0.5).length,
		lowest: rows[0] ? { name: rows[0].name, ratio: rows[0].ratio } : undefined,
	};
	const lines = [
		`${model}: ${rows.length} of ${cases.length} cases counted (${errors.length} refused); overhead ${oh.overhead}${oh.fixed ? "" : " (THE LETTERS DISAGREE)"}; below 0.25: ${summary.below25}; below 0.5: ${summary.below50}; lowest ${rows[0] ? `${rows[0].ratio.toFixed(3)} ${JSON.stringify(rows[0].name)}` : "-"}`,
		...below(0.25).map((r) => `  ${r.ratio.toFixed(3)}  floor ${r.floor}, real ${r.real}  ${JSON.stringify(r.name)}`),
		...errors.slice(0, 5).map((e) => `  refused: ${JSON.stringify(e.name)}: ${e.err}`),
	];
	return { lines, rows, summary };
}

function groups(models, cases, floorOf) {
	const vectors = new Map();
	for (const model of models) {
		const r = reportModel("probe", model, cases, floorOf);
		if (r) vectors.set(model, new Map(r.rows.map((x) => [x.name, x.real])));
	}
	const shared = cases.map((c) => c.key).filter((k) => [...vectors.values()].every((v) => v.has(k)));
	const out = [];
	for (const [model, v] of vectors) {
		const sig = shared.map((k) => v.get(k)).join(",");
		const g = out.find((x) => x.sig === sig);
		if (g) g.models.push(model);
		else out.push({ sig, models: [model] });
	}
	const result = { cases: shared.length, groups: out.map((g) => g.models) };
	writeFileSync(join(OUT, "probe", "groups.json"), JSON.stringify(result, null, 1));
	return result;
}

// ---------------------------------------------------------------- export: the counts for claude-counts.test.ts
/**
 * Writes COUNTS_FILE (default claude-counts.txt beside this file): the models that count the whole sweep alike form a
 * group, and each case of the full sweep gets a row of the first 8 hex digits of its text's SHA-256 and the real
 * tokens of each group ("=" for the same as the group before). A model that has not counted the whole full sweep, each
 * case as its text is now, is left out and named.
 */
async function exportCounts(all) {
	const file = resolve(env.COUNTS_FILE ?? join(here, "claude-counts.txt"));
	const ids = all.map((c) => {
		const text = c.text();
		return { hash: textHash(text), chars: text.length };
	});
	const models = [];
	const reals = new Map();
	for (const model of allModels()) {
		const rows = join(OUT, "sweep", `${model}.jsonl`);
		const ohFile = join(OUT, "overhead", `${model}.json`);
		if (!existsSync(rows) || !existsSync(ohFile)) continue;
		const oh = settle(JSON.parse(readFileSync(ohFile, "utf8")));
		const done = readDone(rows);
		const values = all.map((c, i) => {
			const r = done.get(c.key);
			if (r?.n === undefined || !sameText(r, ids[i].hash, ids[i].chars)) return undefined;
			return r.n - oh.overhead - (r.mode?.includes("suffixed") ? 1 : 0);
		});
		const left = values.filter((v) => v === undefined).length;
		if (left > 0) {
			log(`export: ${model} left out, ${left} of ${all.length} cases not counted`);
			continue;
		}
		models.push(model);
		reals.set(model, values);
	}
	if (models.length === 0) {
		log("export: no model has counted the whole full sweep (run sweep with FLOOR_SWEEP_FULL=1)");
		process.exit(1);
	}
	const groups = [];
	for (const model of models) {
		const g = groups.find((x) => reals.get(x[0]).every((v, i) => v === reals.get(model)[i]));
		if (g) g.push(model);
		else groups.push([model]);
	}
	const lines = [
		"# Claude's real tokens for each case of the floor sweep (FLOOR_SWEEP_FULL=1), counted with Anthropic's token",
		"# counter by floor-sweep-claude.mjs and read by claude-counts.test.ts. A row: the first 8 hex digits of the case",
		'# text\'s SHA-256, then the real tokens of each group below, in order ("=": as the group before). A group is',
		"# the models that count every case alike.",
		...groups.map((g) => `# group ${g.join(" ")}`),
	];
	for (let i = 0; i < all.length; i++) {
		const hash = ids[i].hash.slice(0, 8);
		const values = groups.map((g) => reals.get(g[0])[i]);
		lines.push([hash, ...values.map((v, g) => (g > 0 && v === values[g - 1] ? "=" : v))].join(" "));
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	log(`export: ${all.length} cases, ${groups.length} groups (${models.length} models) to ${file}`);
}

/** MODELS, "all", or the first model of each probe group. */
function sweepModels() {
	if (env.MODELS === "all") return allModels();
	if (env.MODELS) return env.MODELS.split(",");
	const file = join(OUT, "probe", "groups.json");
	if (!existsSync(file)) throw new Error("no probe groups yet: run the probe first, or set MODELS");
	return JSON.parse(readFileSync(file, "utf8")).groups.map((g) => g[0]);
}

// ---------------------------------------------------------------- the optional paid check
/** Short texts for the paid check: a letter, letters around runs of characters Claude drops, CR progress lines. */
const PAID_TEXTS = [
	["a letter", "a"],
	["500 BEL between letters", `a${"\u0007".repeat(500)}a`],
	["500 U+0090 between letters", `a${"\u0090".repeat(500)}a`],
	["500 CR between letters", `a${"\r".repeat(500)}a`],
	[
		"20 progress lines redrawn with CR",
		Array.from({ length: 20 }, (_, i) => `\r[${"#".repeat(i).padEnd(20)}] ${i * 5}%`).join(""),
	],
];

function priceOf(model) {
	const data = JSON.parse(readFileSync(join(root, "packages/ai/src/providers/data/anthropic.json"), "utf8"));
	const m = Object.values(data["anthropic-messages"]).find((x) => x.id === model);
	return m?.cost ? { input: m.cost.input, output: m.cost.output } : undefined;
}

async function billing(key) {
	let list;
	if (env.MODELS === "all") list = allModels();
	else if (env.MODELS) list = env.MODELS.split(",");
	else if (existsSync(join(OUT, "probe", "groups.json")))
		list = JSON.parse(readFileSync(join(OUT, "probe", "groups.json"), "utf8")).groups.map((g) => g[0]);
	else list = ["claude-haiku-4-5", "claude-haiku-5-5"];
	const send = env.PAID_CHECK === "1";
	const rows = [];
	let cost = 0;
	for (const model of list) {
		const price = priceOf(model);
		for (const [name, text] of PAID_TEXTS) {
			const counted = await countOnce(key, model, text);
			if (counted.n === undefined) {
				log(`${model}: ${name}: not counted (${counted.err})`);
				continue;
			}
			// Dollars per million tokens; max_tokens 1, so at most one output token.
			const usd = price ? (counted.n * price.input + price.output) / 1e6 : undefined;
			if (usd !== undefined) cost += usd;
			const row = { model, text: name, counted: counted.n, usd };
			if (send) {
				const r = await post(key, "/v1/messages", {
					model,
					max_tokens: 1,
					messages: [{ role: "user", content: [{ type: "text", text }] }],
				});
				row.billed = r.body?.usage?.input_tokens;
				if (row.billed === undefined) row.err = r.err;
			}
			rows.push(row);
			log(
				`${model}: ${name}: counted ${counted.n}${send ? `, billed ${row.billed ?? `- (${row.err})`}${row.billed === counted.n ? " (equal)" : ""}` : ""}`,
			);
		}
	}
	mkdirSync(OUT, { recursive: true });
	writeFileSync(join(OUT, "billing.json"), JSON.stringify({ sent: send, estimatedUsd: cost, rows }, null, 1));
	if (!send) {
		log(
			`billing: nothing sent. Sending these ${rows.length} requests would cost about $${cost.toFixed(4)} at the prices in anthropic.json; set PAID_CHECK=1 to send them.`,
		);
		return;
	}
	const sent = rows.filter((r) => r.billed !== undefined);
	log(
		`billing: ${sent.filter((r) => r.billed === r.counted).length} of ${sent.length} billed exactly what was counted; about $${cost.toFixed(4)}`,
	);
}

function mkfile(phaseName, model) {
	mkdirSync(join(OUT, phaseName), { recursive: true });
	return join(OUT, phaseName, `${model}.jsonl`);
}

// ---------------------------------------------------------------- phases
async function main() {
	if (!["key", "overhead", "probe", "sweep", "report", "export", "billing"].includes(phase)) {
		console.error(
			"usage: node floor-sweep-claude.mjs key|overhead|probe|sweep|report|export|billing (see floor-sweep-claude.md)",
		);
		process.exit(2);
	}
	const key = (env.ANTHROPIC_API_KEY ?? "").trim();
	// Printable ASCII with no spaces, as an HTTP header carries it. The message never shows the key.
	if (key && !/^[\x21-\x7e]+$/.test(key)) {
		console.error("ANTHROPIC_API_KEY holds a character an HTTP header can't carry, such as a line break");
		process.exit(1);
	}
	if (phase === "key") {
		console.log(key ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY is not set");
		process.exit(key ? 0 : 1);
	}
	if (phase === "billing") {
		if (!key) {
			log("ANTHROPIC_API_KEY is not set: nothing counted");
			process.exit(1);
		}
		await billing(key);
		return;
	}
	const { textTokensFloor } = await import(join(root, ".pi/extensions/penpi/engine/estimator.ts"));
	const all = await sweepCases();
	const sweep = LIMIT === undefined ? all : all.slice(0, LIMIT);
	const probe = all.filter((_, i) => i % PROBE_STEP === 0);
	const floors = new Map();
	const floorOf = (c) => {
		if (!floors.has(c.key)) floors.set(c.key, textTokensFloor(c.text()));
		return floors.get(c.key);
	};
	const models = env.MODELS && env.MODELS !== "all" && phase !== "sweep" ? env.MODELS.split(",") : allModels();

	if (phase === "export") {
		if (!FULL || LIMIT !== undefined) {
			log("export: the counts are of the full sweep: run it with FLOOR_SWEEP_FULL=1 and no LIMIT");
			process.exit(1);
		}
		await exportCounts(all);
		return;
	}
	if (phase === "report") {
		const summary = {};
		for (const [name, cases] of [
			["probe", probe],
			["sweep", sweep],
		])
			for (const model of allModels()) {
				const r = reportModel(name, model, cases, floorOf);
				if (!r) continue;
				for (const line of r.lines) log(`[${name}] ${line}`);
				summary[`${name}/${model}`] = r.summary;
			}
		if (existsSync(join(OUT, "probe")))
			log(`probe groups: ${JSON.stringify(groups(allModels(), probe, floorOf).groups)}`);
		writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
		return;
	}
	if (!key) {
		log("ANTHROPIC_API_KEY is not set: nothing counted");
		process.exit(1);
	}
	log(`${phase}: ANTHROPIC_API_KEY is set; ${BASE_URL}; ${RATE} a minute, ${CONC} in flight; output in ${OUT}`);
	const started = Date.now();
	const ready = [];
	const pass = async (list) => {
		for (const model of list) {
			const oh = await overhead(key, model);
			if (oh.unavailable) {
				log(`${model}: not counted (${oh.unavailable})`);
				continue;
			}
			log(`${model}: overhead ${oh.overhead}${oh.fixed ? "" : ", THE LETTERS DISAGREE"}`);
			ready.push(model);
		}
	};
	if (phase === "overhead") await pass(models);
	else if (phase === "probe") {
		await pass(models);
		for (const model of ready) await countModel(key, model, probe, mkfile("probe", model));
		for (const model of ready)
			for (const line of reportModel("probe", model, probe, floorOf).lines) log(`[probe] ${line}`);
		const g = groups(ready, probe, floorOf);
		log(`probe groups over ${g.cases} cases (identical counts): ${JSON.stringify(g.groups)}`);
	} else {
		const list = sweepModels();
		log(`sweep (${FULL ? "full" : "default"}, ${sweep.length} cases) for ${list.join(", ")}`);
		await pass(list);
		for (const model of ready) {
			await countModel(key, model, sweep, mkfile("sweep", model));
			for (const line of reportModel("sweep", model, sweep, floorOf).lines) log(`[sweep] ${line}`);
		}
	}
	const minutes = (Date.now() - started) / 60_000;
	log(
		`done: ${stats.requests} requests in ${minutes.toFixed(1)} min, ${stats.r429} answered 429, ${stats.retries} retried`,
	);
}

main().catch((e) => {
	log(e instanceof Fatal ? e.message : `error: ${e?.stack ?? e}`);
	process.exit(1);
});
