import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkExtension, scan, stripComments } from "./check-extension-graph.mjs";

/** A working worker: its one node:worker_threads import, and the lite tokenizer. */
const WORKER =
	'import { parentPort, workerData } from "node:worker_threads";\nimport { Tiktoken } from "js-tiktoken/lite";\nimport o200k from "js-tiktoken/ranks/o200k_base";\n' +
	'const t = new Tiktoken(o200k);\nparentPort.on("message", (m) => parentPort.postMessage(t.encode(m).length + workerData.n));\n';

/** An extension in a temporary directory: index.ts imports ./engine/tok.ts, which starts the worker. */
function fixture(files) {
	const dir = mkdtempSync(join(tmpdir(), "extension-graph-"));
	const all = {
		"package.json": JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
		"index.ts": 'import { start } from "./engine/tok.ts";\nexport default start;\n',
		"engine/tok.ts":
			'import { Worker } from "node:worker_threads";\nexport const start = () => new Worker(new URL("./worker.mjs", import.meta.url));\n',
		"engine/worker.mjs": WORKER,
		...files,
	};
	for (const [name, content] of Object.entries(all)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

function check(files) {
	const dir = fixture(files);
	try {
		return checkExtension(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a graph within the rules passes", () => {
	assert.deepEqual(check({}), []);
});

test("the real extension passes", () => {
	assert.deepEqual(checkExtension(join(import.meta.dirname, "../.pi/extensions/penpi")), []);
});

test("the bare js-tiktoken import fails, in each form", () => {
	for (const line of [
		'import { getEncoding } from "js-tiktoken";',
		'export { getEncoding } from "js-tiktoken";',
		'const t = await import("js-tiktoken");',
		'const t = require("js-tiktoken");',
	])
		assert.match(check({ "engine/more.ts": line, "index.ts": 'import "./engine/more.ts";\n' }).join("\n"), /js-tiktoken;/, line);
});

test("rank files other than o200k and cl100k fail", () => {
	const problems = check({ "engine/worker.mjs": `${WORKER}import p50k from "js-tiktoken/ranks/p50k_base";\n` });
	assert.match(problems.join("\n"), /js-tiktoken\/ranks\/p50k_base/);
});

test("a package off the allowed list fails, statically or dynamically", () => {
	assert.match(check({ "index.ts": 'import "left-pad";\n' }).join("\n"), /left-pad is not on the extension's allowed list/);
	assert.match(
		check({ "index.ts": 'const m = await import("left-pad");\n' }).join("\n"),
		/left-pad is not on the extension's allowed list/,
	);
});

const DECLARATION = 'const entry = createRequire(realpathSync(fileURLToPath(import.meta.url))).resolve("pi-mcp-adapter");\n';
const ADAPTER = `import { createRequire } from "node:module";\n${DECLARATION}await import(entry);\n`;

test("a non-literal import() or require() fails, and index.ts's exception is its one exact declaration", () => {
	assert.match(check({ "engine/tok.ts": "const m = await import(name);\n", "index.ts": 'import "./engine/tok.ts";\n' }).join("\n"), /non-literal import\(name\)/);
	assert.match(check({ "index.ts": "const m = require(name);\n" }).join("\n"), /non-literal require\(name\)/);
	// The exception needs its declaration, and covers only its own import(), once.
	assert.match(check({ "index.ts": "const m = await import(entry);\n" }).join("\n"), /non-literal import\(entry\)/);
	assert.deepEqual(check({ "index.ts": ADAPTER }), []);
	assert.match(check({ "index.ts": `${ADAPTER}await import(entry);\n` }).join("\n"), /must appear exactly once/);
	assert.match(
		check({ "index.ts": `${ADAPTER}await import("js-" + "tiktoken");\n` }).join("\n"),
		/non-literal import\("js-" \+ "tiktoken"\)/,
	);
	// The declaration must be the exact one: another resolve, or a let, fails.
	assert.match(
		check({ "index.ts": ADAPTER.replace("realpathSync(fileURLToPath(import.meta.url))", "import.meta.url") }).join("\n"),
		/index.ts: createRequire/,
	);
	assert.match(check({ "index.ts": ADAPTER.replace("const entry", "let entry") }).join("\n"), /index.ts: createRequire/);
	// entry reassigned, or bound again, beside the declaration.
	for (const tail of [
		'entry = "js-tiktoken";\nawait import(entry);\n',
		'await import(entry);\n{\n\tconst entry = "node:child_process";\n}\n',
		"await import(entry);\nconst f = (entry) => entry;\n",
	])
		assert.match(
			check({ "index.ts": `import { createRequire } from "node:module";\n${DECLARATION}${tail}` }).join("\n"),
			/entry is bound or assigned outside the exception's declaration/,
			tail,
		);
	// The adapter's resolve into another name, then entry bound to another literal.
	assert.match(
		check({
			"index.ts": `import { createRequire } from "node:module";\n${DECLARATION.replace("const entry", "const x")}const entry = "node:child_process";\nawait import(entry);\n`,
		}).join("\n"),
		/index.ts: createRequire/,
	);
	// The exception is index.ts's only: the same lines elsewhere fail.
	assert.match(check({ "engine/tok.ts": ADAPTER, "index.ts": 'import "./engine/tok.ts";\n' }).join("\n"), /engine\/tok.ts: createRequire/);
});

test("createRequire fails everywhere but the exception, under any name", () => {
	for (const line of [
		'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nr("js-tiktoken");\n',
		'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("js-tiktoken");\n',
		'import * as m from "node:module";\nconst r = m.createRequire(import.meta.url);\n',
	])
		assert.match(check({ "engine/more.ts": line, "index.ts": 'import "./engine/more.ts";\n' }).join("\n"), /createRequire/, line);
});

test("getBuiltinModule fails anywhere in the extension, by name or in a string", () => {
	for (const line of ['const m = process.getBuiltinModule("node:worker_threads");', 'const m = process["getBuiltinModule"]("fs");'])
		assert.match(check({ "index.ts": `import "./engine/tok.ts";\n${line}\n` }).join("\n"), /index.ts: getBuiltinModule/, line);
});

test("imports and re-exports are found without spaces", () => {
	for (const line of ['import {a}from "js-tiktoken";', 'import{a}from"js-tiktoken";', 'export*from"js-tiktoken";', 'import"js-tiktoken";'])
		assert.match(check({ "engine/more.ts": line, "index.ts": 'import "./engine/more.ts";\n' }).join("\n"), /js-tiktoken;/, line);
});

test("a template literal with no ${} is a literal; with one, it is not", () => {
	assert.match(check({ "index.ts": "await import(`js-tiktoken`);\n" }).join("\n"), /js-tiktoken;/);
	assert.match(check({ "index.ts": "await import(`js-${name}`);\n" }).join("\n"), /non-literal import/);
});

test("type-only imports and comments don't count", () => {
	assert.deepEqual(
		check({
			"index.ts":
				'import type { X } from "left-pad";\n// import "left-pad";\n/* require("left-pad") */\nconst s = "import(\'left-pad\')";\n',
		}),
		[],
	);
});

test("a working worker, with parentPort and the lite import, passes, with workerData or without", () => {
	assert.deepEqual(check({}), []);
	assert.deepEqual(
		check({
			"engine/worker.mjs":
				'import { parentPort } from "node:worker_threads";\nimport { Tiktoken } from "js-tiktoken/lite";\nparentPort.on("message", (b) => new Tiktoken(b));\n',
		}),
		[],
	);
});

test("the worker found through new Worker(new URL(...)) has no network, files, crypto, processes or loaders", () => {
	for (const [line, problem] of [
		['import { request } from "node:https";', /the worker reaches node:https/],
		['import net from "node:net";', /the worker reaches node:net/],
		['import { spawn } from "node:child_process";', /the worker reaches node:child_process/],
		['import { readFileSync } from "node:fs";', /the worker reaches node:fs/],
		['import { writeFile as w } from "node:fs/promises";\nawait w(p, b);', /the worker reaches node:fs\/promises/],
		['import { createHash } from "node:crypto";', /the worker reaches node:crypto/],
		['import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("node:https");', /the worker reaches node:module/],
		['import vm from "node:vm";', /the worker reaches node:vm/],
		['import { Session } from "node:inspector";', /the worker reaches node:inspector/],
		['import cluster from "node:cluster";', /the worker reaches node:cluster/],
		// node:worker_threads only as { parentPort, workerData }, static and named.
		['import { Worker } from "node:worker_threads";', /the worker may import only \{ parentPort, workerData \}/],
		['import * as wt from "node:worker_threads";', /the worker may import only \{ parentPort, workerData \}/],
		['import wt from "node:worker_threads";', /the worker may import only \{ parentPort, workerData \}/],
		['import { parentPort as p } from "node:worker_threads";', /the worker may import only \{ parentPort, workerData \}/],
		['import { parentPort, MessageChannel } from "node:worker_threads";', /the worker may import only \{ parentPort, workerData \}/],
		['const { parentPort: p } = await import("node:worker_threads");', /the worker may import only \{ parentPort, workerData \}/],
		['const { parentPort: p } = require("node:worker_threads");', /the worker may import only \{ parentPort, workerData \}/],
		// The network and loaders by name, whatever reaches them.
		["const r = await fetch(url);", /the worker uses fetch/],
		["const f = globalThis.fetch;\nawait f(url);", /the worker uses fetch/],
		['const f = globalThis["fe" + "tch"];', /the worker uses globalThis/],
		['const f = global["fe" + "tch"];', /the worker uses global/],
		['const f = self["fe" + "tch"];', /the worker uses self/],
		['eval("fet" + "ch(u)");', /the worker uses eval/],
		['const f = new Function("return fet" + "ch")();', /the worker uses Function/],
		['const f = Reflect.get(o, "fe" + "tch");', /the worker uses Reflect/],
		['const net = process.getBuiltinModule("node:net");', /the worker uses process/],
		['const fs = process["getBuiltinModule"]("fs");\nfs.writeFileSync(p, b);', /getBuiltinModule/],
		['process.dlopen(m, "x.node");', /the worker uses process/],
		["const s = new WebSocket(url);", /the worker uses WebSocket/],
		["const x = new XMLHttpRequest();", /the worker uses XMLHttpRequest/],
	])
		assert.match(check({ "engine/worker.mjs": `${WORKER}${line}\n` }).join("\n"), problem, line);
});

test("a worker started any other way fails, and its file is never trusted unwalked", () => {
	for (const start of [
		"new Worker(new URL(`./worker.mjs`, import.meta.url))",
		'new Worker("./worker.mjs")',
		"new Worker(path)",
		'new Worker(new URL("./worker.mjs", import.meta.url).pathname)',
	]) {
		const tok = `import { Worker } from "node:worker_threads";\nexport const start = () => ${start};\n`;
		// A template literal with no ${} is the literal form, and is walked.
		if (start.includes("`")) {
			assert.deepEqual(check({ "engine/tok.ts": tok }), [], start);
			assert.match(check({ "engine/tok.ts": tok, "engine/worker.mjs": `${WORKER}await fetch(u);\n` }).join("\n"), /the worker uses fetch/, start);
		} else assert.match(check({ "engine/tok.ts": tok }).join("\n"), /a worker started another way/, start);
	}
});

test("the Worker binding appears only in its import and the literal start; any other use fails", () => {
	const literalStart = 'export const a = () => new Worker(new URL("./worker.mjs", import.meta.url));\n';
	const importWorker = 'import { Worker } from "node:worker_threads";\n';
	for (const [tok, problem] of [
		// Each of these starts a worker the check would not walk.
		[`${importWorker}${literalStart}export const b = () => Reflect.construct(Worker, [new URL("./w.mjs", import.meta.url)]);\n`, /Worker used outside/],
		[`${importWorker}${literalStart}const C = Worker;\nexport const b = () => new C("./w.mjs");\n`, /Worker used outside/],
		[`${literalStart}import * as wt from "node:worker_threads";\nconst C = wt.Worker;\nexport const b = () => new C("./w.mjs");\n`, /may be imported only as import \{ Worker \}/],
		[`${literalStart}import * as wt from "node:worker_threads";\nconst C = wt.Worker;\n`, /Worker used outside/],
		[`const { Worker: W } = await import("node:worker_threads");\nexport const b = () => new W("./w.mjs");\n`, /may be imported only as import \{ Worker \}/],
		[`const { Worker: W } = await import("node:worker_threads");\n`, /Worker used outside/],
		[`import { Worker as W } from "node:worker_threads";\nexport const b = () => new W(new URL("./worker.mjs", import.meta.url));\n`, /may be imported only as import \{ Worker \}/],
		[`const { Worker } = require("node:worker_threads");\n${literalStart}`, /may be imported only as import \{ Worker \}/],
		[`import { Worker, MessageChannel } from "node:worker_threads";\n${literalStart}`, /may be imported only as import \{ Worker \}/],
		[`${importWorker}${literalStart}let W;\nW = Worker;\n`, /Worker used outside/],
		// node:worker_threads only in a file that starts a worker.
		[`${importWorker}export const a = () => 1;\n`, /imports Worker from node:worker_threads but starts no worker/],
	])
		assert.match(check({ "engine/tok.ts": tok }).join("\n"), problem, tok);
});

test("a worker's built-ins are an allowed list: node:worker_threads in its one form, nothing else", () => {
	for (const line of [
		'import p from "node:process";\np["getBuilt" + "inModule"]("node:fs");',
		'const p = await import("node:process");',
		'import { DatabaseSync } from "node:sqlite";',
		'import { WASI } from "node:wasi";',
		'import { writeHeapSnapshot } from "node:v8";',
		'import repl from "node:repl";',
		'import { setTimeout } from "node:timers/promises";',
	])
		assert.match(check({ "engine/worker.mjs": `${WORKER}${line}\n` }).join("\n"), /the worker reaches node:/, line);
});

test("a worker's packages are an allowed list: the tokenizer libraries, not the rest of the extension's", () => {
	for (const line of [
		'import { complete } from "@earendil-works/pi-ai";',
		'const m = await import("@earendil-works/pi-coding-agent");',
		'export { Type } from "typebox";',
	])
		assert.match(
			check({ "engine/worker.mjs": `${WORKER}${line}\n` }).join("\n"),
			/the worker imports .*; a worker imports only js-tiktoken\/lite/,
			line,
		);
	assert.deepEqual(check({ "engine/worker.mjs": `${WORKER}import { Tokenizer } from "@huggingface/tokenizers";\n` }), []);
	// The main graph keeps the extension's whole list.
	assert.deepEqual(check({ "index.ts": 'import { complete } from "@earendil-works/pi-ai";\nimport "./engine/tok.ts";\n' }), []);
});

test("in a worker, an identifier spelled with a Unicode escape fails; backslashes in strings and regexes don't", () => {
	assert.match(
		check({
			"engine/worker.mjs": `${WORKER}const fs = pro\\u0063ess.getBuiltinModul\\u0065("node:fs");\nf\\u0065tch("u");\n`,
		}).join("\n"),
		/a backslash outside strings, templates and regexes/,
	);
	assert.deepEqual(
		check({ "engine/worker.mjs": `${WORKER}const a = "\\n\\u0063";\nconst r = /\\d+\\|/u;\nconst t = \`\\\${x}\`;\n` }),
		[],
	);
});

test("a template's substitutions are code: what they hold is checked", () => {
	assert.match(
		check({ "engine/worker.mjs": `${WORKER}const s = \`\${fetch("https://example.com")}\`;\n` }).join("\n"),
		/the worker uses fetch/,
	);
	assert.match(check({ "index.ts": "const s = `${await import(name)}`;\n" }).join("\n"), /non-literal import\(name\)/);
	assert.match(
		check({
			"engine/tok.ts":
				'import { Worker } from "node:worker_threads";\nexport const a = () => new Worker(new URL("./worker.mjs", import.meta.url));\nconst s = `${new Worker(new URL("./w.mjs", import.meta.url))}`;\n',
			"engine/w.mjs": `${WORKER}await fetch(u);\n`,
		}).join("\n"),
		/the worker uses fetch/,
	);
	assert.match(
		check({
			"index.ts": `import { createRequire } from "node:module";\n${DECLARATION}await import(entry);\nconst s = \`\${(() => { const entry = "node:child_process"; return import(entry); })()}\`;\n`,
		}).join("\n"),
		/entry is bound or assigned outside|must appear exactly once/,
	);
	// Nested templates and braces inside a substitution.
	assert.match(
		check({ "engine/worker.mjs": `${WORKER}const s = \`a \${\`b \${ { x: 1 }.x } c\`} \${fetch(u)} d\`;\n` }).join("\n"),
		/the worker uses fetch/,
	);
	// The text parts are still blanked: a word in them is not code.
	assert.deepEqual(check({ "engine/worker.mjs": `${WORKER}const s = \`fetch the \${1 + 1} files\`;\n` }), []);
});

test("in the worker, .constructor fails by name, and a slash after a postfix ++ divides", () => {
	assert.match(
		check({ "engine/worker.mjs": `${WORKER}const F = (() => {}).constructor;\n` }).join("\n"),
		/the worker uses constructor/,
	);
	assert.match(
		check({ "engine/worker.mjs": `${WORKER}let a = 1;\na = a++ / 2; fetch(u); a = 3 / 4;\n` }).join("\n"),
		/the worker uses fetch/,
	);
});

test("the main graph may use the network; only the worker's is held to it", () => {
	assert.deepEqual(check({ "index.ts": 'import { request } from "node:https";\nimport "./engine/tok.ts";\n' }), []);
});

test("a worker file that is missing, or that starts another worker, fails", () => {
	assert.match(
		check({
			"engine/tok.ts":
				'import { Worker } from "node:worker_threads";\nexport const s = () => new Worker(new URL("./gone.mjs", import.meta.url));\n',
		}).join("\n"),
		/worker \.\/gone\.mjs doesn't resolve/,
	);
	assert.match(
		check({ "engine/worker.mjs": `${WORKER}new Worker(new URL("./worker.mjs", import.meta.url));\n` }).join("\n"),
		/a worker starts another worker/,
	);
});

test("comments are blanked; strings, template literals and regex literals are kept", () => {
	assert.equal(stripComments('a // x\nb /* y\nz */ c "//" `/*` /["\']/'), 'a \nb \n c "//" `/*` /["\']/');
	assert.deepEqual(scan('const r = /["\']/; import x from "./y";').specs, ["./y"]);
});
