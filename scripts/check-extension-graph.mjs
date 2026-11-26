#!/usr/bin/env node
/**
 * The PENpi extension's import graph, and the tokenizer worker's (0.9.0, DP1).
 *
 * check-entry-graphs.mjs walks the workspace packages' `exports` only. This walks the extension from its entry
 * files, and every worker file it starts, through static imports and re-exports (spaced or not), and `import()` and
 * `require()` with a literal. Comments are skipped, and string, template and regex contents are blanked before
 * anything is matched, so text inside them is never taken for code. A template's `${…}` substitutions are code, and are
 * kept as code, nested templates and brace depth included.
 *
 * - Every bare specifier must be on ALLOWED; js-tiktoken only as `js-tiktoken/lite` and the o200k and cl100k ranks.
 * - An `import()` or `require()` of anything but a literal fails. `createRequire` and `getBuiltinModule` fail
 *   everywhere, by name, in strings too. DYNAMIC names the one exception, by its exact declaration.
 * - The `Worker` binding may appear only in `import { Worker } from "node:worker_threads"`, in a file that starts a
 *   worker, and in `new Worker(new URL(<literal>, import.meta.url))`. Any other use of the name fails, so every worker
 *   is started in the literal form and walked.
 * - A worker's graph imports no built-in module but `node:worker_threads`, and that only as `import { parentPort,
 *   workerData } from "node:worker_threads"`: an allowed list, so `node:process`, `node:sqlite` or `node:wasi` fail as
 *   `node:fs` does. Its packages are an allowed list too, WORKER_ALLOWED: `js-tiktoken/lite`, the o200k and cl100k
 *   ranks and `@huggingface/tokenizers`, and no other package the extension may import. It names none of the
 *   identifiers `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `createRequire`, `eval`, `Function`,
 *   `constructor`, `globalThis`, `global`, `self`, `Reflect` or `process`, and no backslash is left in it once its
 *   strings, template text and regexes are blanked: one there is in an identifier, spelled with a Unicode escape that
 *   the rules by name would miss. The main thread reads and checks the tokenizer's bytes and hands them over.
 *
 * The rules are by name: the check catches our own mistakes, such as a full js-tiktoken import, a stray `fetch` in the
 * worker or a worker that isn't walked. It isn't a sandbox against hostile code, and these pass it:
 * - a property reached by a computed name built from strings (`x["fe" + "tch"]` on an object the check doesn't name);
 * - `eval` and `Function` in the main graph, where the network is allowed anyway;
 * - a regular expression misread as a division, or the reverse: the scanner decides by the token before the slash, so
 *   an odd form can hide code from it, or blank code as a regex.
 *
 * Type-only imports are erased before Node runs the file, so they don't count.
 *
 * Usage: check-extension-graph.mjs [extension dir], default .pi/extensions/penpi.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bare specifiers the extension may import: a package name, or a name ending in "/" for any of its subpaths. */
export const ALLOWED = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@huggingface/tokenizers",
	"@modelcontextprotocol/sdk/",
	"js-tiktoken/lite",
	"js-tiktoken/ranks/cl100k_base",
	"js-tiktoken/ranks/o200k_base",
	"pi-mcp-adapter",
	"typebox",
];

/** The only bare specifiers a worker's graph may import: the tokenizer libraries, and nothing else on ALLOWED. */
export const WORKER_ALLOWED = [
	"@huggingface/tokenizers",
	"js-tiktoken/lite",
	"js-tiktoken/ranks/cl100k_base",
	"js-tiktoken/ranks/o200k_base",
];

/**
 * The one exception to "no createRequire, no non-literal import()": index.ts imports pi-mcp-adapter by its resolved
 * real path, so a symlinked install still finds the repository's copy. Only this exact declaration is allowed, once,
 * with `import(entry)` once, and `entry` named nowhere else in the file.
 */
export const DYNAMIC = {
	"index.ts": {
		declaration:
			/(?<![\w$.])const\s+entry\s*=\s*createRequire\s*\(\s*realpathSync\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)\s*\)\s*\.resolve\s*\(\s*"pi-mcp-adapter"\s*\)\s*;/g,
		name: /(?<![\w$.])entry(?![\w$])/g,
		nonLiteral: "import(entry)",
	},
};

/**
 * Identifiers a worker must not mention at all: called, aliased or passed on. The worker needs none of them: it
 * takes `parentPort` from its one `node:worker_threads` import.
 */
const WORKER_FORBIDDEN_NAMES =
	/(?<![\w$])(fetch|WebSocket|XMLHttpRequest|EventSource|createRequire|eval|Function|constructor|globalThis|global|self|Reflect|process)(?![\w$])/g;
/** The one import of `node:worker_threads` each graph may have, as its clause reads with spaces removed. */
const WORKER_THREADS_MAIN = /^import\{Worker,?\}from$/;
const WORKER_THREADS_WORKER = /^import\{(?:parentPort|workerData)(?:,(?:parentPort|workerData))?,?\}from$/;

/** Whether a "/" after this output starts a regex literal rather than a division. */
function regexCanStart(out) {
	let end = out.length;
	while (end > 0 && /\s/.test(out[end - 1])) end--;
	if (end === 0) return true;
	const before = out.slice(Math.max(0, end - 12), end);
	// After a postfix `++` or `--`, a slash divides (`a++ / 2`).
	if (/(\+\+|--)$/.test(before)) return false;
	if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(before)) return true;
	return /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(before);
}

/**
 * One pass over `source`, as code. `strip`: comments are blanked out (line breaks kept). `blank`: the contents of
 * strings, of a template's text parts and of regex literals are blanked to spaces (offsets kept). A template's `${…}`
 * substitutions are code either way: walked as code, with brace depth and nested templates.
 */
function transform(source, { strip, blank }) {
	let out = "";
	let i = 0;
	const text = (ch) => (blank && ch !== "\n" ? " " : ch);
	const template = () => {
		out += "`";
		i++;
		while (i < source.length && source[i] !== "`") {
			if (source[i] === "\\") {
				out += text(source[i]) + text(source[i + 1] ?? "");
				i += 2;
			} else if (source[i] === "$" && source[i + 1] === "{") {
				out += "${";
				i += 2;
				code(true);
				if (source[i] === "}") {
					out += "}";
					i++;
				}
			} else {
				out += text(source[i]);
				i++;
			}
		}
		out += source[i] ?? "";
		i++;
	};
	/** Code up to the end, or, inside a substitution, up to its closing brace (left for the caller). */
	const code = (substitution) => {
		let depth = 0;
		while (i < source.length) {
			const c = source[i];
			const next = source[i + 1];
			if (c === "/" && next === "/") {
				const end = source.indexOf("\n", i);
				const stop = end < 0 ? source.length : end;
				if (!strip) out += source.slice(i, stop);
				i = stop;
			} else if (c === "/" && next === "*") {
				const end = source.indexOf("*/", i + 2);
				const stop = end < 0 ? source.length : end + 2;
				out += strip ? source.slice(i, stop).replace(/[^\n]/g, "") : source.slice(i, stop);
				i = stop;
			} else if (c === "/" && regexCanStart(out)) {
				// A regex literal, whole: a quote or "//" inside it is not taken for a string or a comment.
				let inClass = false;
				out += c;
				i++;
				while (i < source.length && source[i] !== "\n") {
					const r = source[i];
					i++;
					if (r === "\\") {
						out += text(r) + text(source[i] ?? "");
						i++;
					} else if (r === "/" && !inClass) {
						out += r;
						break;
					} else {
						if (r === "[") inClass = true;
						else if (r === "]") inClass = false;
						out += text(r);
					}
				}
			} else if (c === '"' || c === "'") {
				out += c;
				i++;
				while (i < source.length && source[i] !== c && source[i] !== "\n") {
					if (source[i] === "\\") {
						out += text(source[i]) + text(source[i + 1] ?? "");
						i += 2;
					} else {
						out += text(source[i]);
						i++;
					}
				}
				out += source[i] ?? "";
				i++;
			} else if (c === "`") template();
			else {
				if (substitution) {
					if (c === "{") depth++;
					else if (c === "}") {
						if (depth === 0) return;
						depth--;
					}
				}
				out += c;
				i++;
			}
		}
	};
	code(false);
	return out;
}

/** The source with comments blanked out, strings and template literals kept. Line breaks are kept. */
export function stripComments(source) {
	return transform(source, { strip: true, blank: false });
}

/** `code` with the contents of strings, template text and regex literals blanked to spaces, so offsets stay the same. */
function blankStrings(code) {
	return transform(code, { strip: false, blank: true });
}

// Matched on the blanked copy, so text inside a string is never taken for code. Offsets then read each literal from
// the code itself.
const STATIC = /(?<![\w$.])(?:import|export)\b(?=(\s*))\1(?!type\b)(?![.(])(?:[^;'"`]*?\bfrom)?\s*(["'`] *["'`])/dg;
const CALL = /(?<![\w$.])(import|require)\s*\(/dg;
const WORKER_FORM = /^new\s+Worker\s*\(\s*new\s+URL\s*\(\s*(["'`] *["'`])\s*,\s*import\.meta\.url\s*\)\s*(?:\.href\s*)?[,)]/d;
// The Worker binding by name, a property access (`wt.Worker`) included.
const WORKER_NAME = /(?<![\w$])Worker(?![\w$])/g;
// By name anywhere, a property access (`m.createRequire`) included.
const CREATE_REQUIRE = /(?<![\w$])createRequire(?![\w$])/g;
// By name anywhere, in strings too (`process["getBuiltinModule"]`).
const GET_BUILTIN = /getBuiltinModule/g;

/** A literal's text: a quoted string, or a template literal without `${`. Undefined otherwise. */
function literal(text) {
	const m = /^(["'`])((?:(?!\1)[^\\]|\\.)*)\1$/.exec(text.trim());
	if (!m || (m[1] === "`" && m[2].includes("${"))) return undefined;
	return m[2];
}

/** The end of the call whose "(" is at `open` in the blanked code: the offset of its ")". */
function closeOf(blank, open) {
	let depth = 0;
	for (let i = open; i < blank.length; i++) {
		if (blank[i] === "(") depth++;
		else if (blank[i] === ")" && --depth === 0) return i;
	}
	return blank.length;
}

/**
 * The imports of one file: specifiers (each with how it was loaded and, for a static import, its clause), worker
 * files, worker starts of another form, other uses of the Worker name, and non-literal loads.
 */
export function scan(source) {
	const code = stripComments(source);
	const blank = blankStrings(code);
	const at = (m, group) => code.slice(m.indices[group][0], m.indices[group][1]);
	const imports = [];
	const workers = [];
	const otherWorkers = [];
	const nonLiteral = [];
	// Offsets of the Worker names the rules allow: in `import { Worker } from "node:worker_threads"`, and in a literal
	// `new Worker(new URL(...))`.
	const allowedNames = new Set();
	for (const m of blank.matchAll(STATIC)) {
		const spec = literal(at(m, 2));
		if (spec === undefined) continue;
		const clause = blank.slice(m.index, m.indices[2][0]).replace(/\s+/g, "");
		imports.push({ spec, how: "static", clause });
		if (spec.replace(/^node:/, "") === "worker_threads" && WORKER_THREADS_MAIN.test(clause))
			for (const w of blank.slice(m.index, m.indices[2][0]).matchAll(WORKER_NAME)) allowedNames.add(m.index + w.index);
	}
	for (const m of blank.matchAll(CALL)) {
		const open = m.indices[0][1] - 1;
		const argument = code.slice(open + 1, closeOf(blank, open)).trim();
		const spec = literal(argument);
		if (spec !== undefined) imports.push({ spec, how: `${m[1]}()` });
		else nonLiteral.push(`${m[1]}(${argument})`);
	}
	const otherNames = [];
	for (const m of blank.matchAll(WORKER_NAME)) {
		if (allowedNames.has(m.index)) continue;
		const start = /new\s+$/.exec(blank.slice(Math.max(0, m.index - 20), m.index));
		if (!start || blank[m.index - 1] === ".") {
			otherNames.push(code.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, " ").trim());
			continue;
		}
		const from = m.index - start[0].length;
		const form = WORKER_FORM.exec(blank.slice(from));
		const url = form ? literal(code.slice(from + form.indices[1][0], from + form.indices[1][1])) : undefined;
		if (url !== undefined) workers.push(url);
		else otherWorkers.push(code.slice(from, closeOf(blank, blank.indexOf("(", m.index)) + 1).replace(/\s+/g, " "));
	}
	const createRequire = [...blank.matchAll(CREATE_REQUIRE)].length;
	const getBuiltinModule = [...code.matchAll(GET_BUILTIN)].length;
	return {
		code,
		blank,
		imports,
		specs: imports.map((i) => i.spec),
		workers,
		otherWorkers,
		otherNames,
		nonLiteral,
		createRequire,
		getBuiltinModule,
	};
}

function resolveLocal(spec, fromFile) {
	const base = resolve(dirname(fromFile), spec);
	for (const candidate of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`])
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	return undefined;
}

function allowedBare(spec) {
	return ALLOWED.some((a) => (a.endsWith("/") ? spec.startsWith(a) : spec === a));
}

/** Walk one graph from `entry`. Returns its files, the worker files it starts, and the problems found. */
function walk(entry, dir, { worker }) {
	const files = new Set();
	const workers = new Set();
	const problems = [];
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop();
		if (files.has(file)) continue;
		files.add(file);
		const rel = relative(dir, file).split(sep).join("/");
		const found = scan(readFileSync(file, "utf8"));
		const exception = worker ? undefined : DYNAMIC[rel];
		// The exception: its declaration once, createRequire twice (its import and the declaration), its non-literal
		// import() once, and `entry` named only in those two places.
		const declarations = exception ? [...found.code.matchAll(exception.declaration)].length : 0;
		if (exception && declarations === 1 && found.createRequire === 2) {
			const others = found.nonLiteral.filter((c) => c !== exception.nonLiteral);
			if (found.nonLiteral.length - others.length !== 1)
				problems.push(`${rel}: the exception's ${exception.nonLiteral} must appear exactly once`);
			if ([...found.blank.matchAll(exception.name)].length !== 2)
				problems.push(`${rel}: entry is bound or assigned outside the exception's declaration`);
			for (const call of others) problems.push(`${rel}: a non-literal ${call}`);
		} else {
			if (found.createRequire > 0) problems.push(`${rel}: createRequire`);
			for (const call of found.nonLiteral) problems.push(`${rel}: a non-literal ${call}`);
		}
		if (found.getBuiltinModule > 0) problems.push(`${rel}: getBuiltinModule`);
		for (const start of found.otherWorkers)
			problems.push(`${rel}: a worker started another way than new Worker(new URL(<literal>, import.meta.url)): ${start}`);
		for (const use of found.otherNames)
			problems.push(
				`${rel}: Worker used outside import { Worker } from "node:worker_threads" and new Worker(new URL(<literal>, import.meta.url)): ${use}`,
			);
		for (const { spec, how, clause } of found.imports) {
			if (spec.replace(/^node:/, "") !== "worker_threads") continue;
			if (worker && !(how === "static" && WORKER_THREADS_WORKER.test(clause ?? "")))
				problems.push(`${rel}: the worker may import only { parentPort, workerData } from node:worker_threads`);
			else if (!worker && !(how === "static" && WORKER_THREADS_MAIN.test(clause ?? "")))
				problems.push(`${rel}: node:worker_threads may be imported only as import { Worker } from "node:worker_threads"`);
			else if (!worker && found.workers.length === 0)
				problems.push(`${rel}: imports Worker from node:worker_threads but starts no worker`);
		}
		for (const spec of found.specs) {
			if (spec.startsWith(".")) {
				const target = resolveLocal(spec, file);
				if (target === undefined) problems.push(`${rel}: ${spec} doesn't resolve`);
				else if (!target.startsWith(dir + sep)) problems.push(`${rel}: ${spec} leaves the extension`);
				else if (!target.endsWith(".json")) queue.push(target);
				continue;
			}
			const name = spec.replace(/^node:/, "");
			if (spec.startsWith("node:") || isBuiltin(spec)) {
				// An allowed list: node:worker_threads in its one form (checked above), and no other built-in.
				if (worker && name !== "worker_threads")
					problems.push(`${rel}: the worker reaches ${spec}; a worker imports no built-in but { parentPort, workerData }`);
				continue;
			}
			if (spec === "js-tiktoken" || (spec.startsWith("js-tiktoken/") && !allowedBare(spec)))
				problems.push(`${rel}: ${spec}; only js-tiktoken/lite and the o200k and cl100k ranks`);
			else if (!allowedBare(spec)) problems.push(`${rel}: ${spec} is not on the extension's allowed list`);
			else if (worker && !WORKER_ALLOWED.includes(spec))
				problems.push(
					`${rel}: the worker imports ${spec}; a worker imports only js-tiktoken/lite, its two ranks and @huggingface/tokenizers`,
				);
		}
		for (const w of found.workers) {
			const target = resolveLocal(w, file);
			if (target === undefined) problems.push(`${rel}: worker ${w} doesn't resolve`);
			else workers.add(target);
		}
		if (worker) {
			for (const m of new Set([...found.blank.matchAll(WORKER_FORBIDDEN_NAMES)].map((x) => x[1])))
				problems.push(`${rel}: the worker uses ${m}`);
			if (found.blank.includes("\\"))
				problems.push(`${rel}: a backslash outside strings, templates and regexes: an identifier spelled with an escape`);
		}
	}
	return { files, workers, problems };
}

/** Check the extension in `dir`: its entries' graphs, then every worker's. Returns the problems. */
export function checkExtension(extensionDir) {
	const dir = resolve(extensionDir);
	const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
	const entries = [...(manifest.pi?.extensions ?? []), "./engine-only.ts"]
		.map((e) => resolve(dir, e))
		.filter((e) => existsSync(e));
	const problems = [];
	const workers = new Set();
	for (const entry of entries) {
		const graph = walk(entry, dir, { worker: false });
		problems.push(...graph.problems);
		for (const w of graph.workers) workers.add(w);
	}
	for (const w of workers) {
		const graph = walk(w, dir, { worker: true });
		problems.push(...graph.problems);
		if (graph.workers.size > 0) problems.push(`${relative(dir, w)}: a worker starts another worker`);
	}
	return [...new Set(problems)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dir = resolve(ROOT, process.argv[2] ?? ".pi/extensions/penpi");
	const problems = checkExtension(dir);
	if (problems.length > 0) {
		console.error(`${problems.map((p) => `  ${p}`).join("\n")}\n\n${problems.length} extension graph problem(s).`);
		process.exit(1);
	}
	console.log("The extension's import graph and its workers are within their rules.");
}
