/**
 * Real material from the Pi checkout the harness runs in: source files (TypeScript with tabs, Rust with
 * 4 spaces, YAML with 2, C, shell, CSS, HTML, minified JS), Markdown documentation (prose and markup),
 * JSON files, PNG screenshots and a WebAssembly binary. Only files tracked by git are used, and the
 * engine's own test directories are left out. `fingerprint` hashes every file
 * used; two machines on the same tag (v1.1.0) produce the same corpus and therefore the same sessions.
 *
 * PENpi: the corpus is read from upstream Pi's tree at the recorded base (E2_CORPUS_REV, default the
 * `base:` line of docs/UPSTREAM_PATCHES.txt) through git objects, not from the working tree, so a run in
 * the fork builds the same sessions as one on stock Pi and does not change with each PENpi commit.
 * E2_CORPUS_REV=worktree reads the checkout as before.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

export interface SourceFile {
	path: string;
	text: string;
	lang: string;
}

export interface Corpus {
	code: SourceFile[];
	/** Prose paragraphs (Markdown syntax stripped). */
	paragraphs: string[];
	/** Markdown sections, verbatim. */
	sections: string[];
	html: string[];
	json: Array<{ path: string; value: unknown }>;
	images: Array<{ path: string; data: string; mimeType: string; width: number; height: number }>;
	binaries: Array<{ path: string; bytes: Buffer }>;
	/** Every tracked file with its size (for `ls -l` tables). */
	listing: Array<{ path: string; size: number }>;
	fingerprint: string;
}

const CODE_EXT: Record<string, string> = {
	ts: "typescript",
	mjs: "javascript",
	js: "javascript",
	cjs: "javascript",
	rs: "rust",
	c: "c",
	h: "c",
	sh: "shell",
	yml: "yaml",
	css: "css",
	html: "html",
	toml: "toml",
};

let cached: Corpus | undefined;

/** The upstream commit the corpus is read from, or undefined for the working tree. */
function corpusRev(): string | undefined {
	const rev = process.env.E2_CORPUS_REV;
	if (rev === "worktree") return undefined;
	if (rev) return rev;
	const manifest = readFileSync(join(REPO_ROOT, "docs", "UPSTREAM_PATCHES.txt"), "utf8");
	const base = /^base: ([0-9a-f]{40})\b/m.exec(manifest)?.[1];
	if (!base) throw new Error("E2: no base line in docs/UPSTREAM_PATCHES.txt; set E2_CORPUS_REV");
	return base;
}

interface CorpusSource {
	files: string[];
	size(path: string): number | undefined;
	bytes(path: string): Buffer;
}

function worktreeSource(): CorpusSource {
	const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
	const files = out
		.split("\0")
		.filter((p) => p.length > 0 && !/test\/suite\/context-engine/.test(p))
		.sort();
	return {
		files,
		size: (path) => {
			try {
				return statSync(join(REPO_ROOT, path)).size;
			} catch {
				return undefined;
			}
		},
		bytes: (path) => readFileSync(join(REPO_ROOT, path)),
	};
}

/** Every blob of `rev`, read once through `git cat-file --batch`. */
function revisionSource(rev: string): CorpusSource {
	const git = (args: string[], input?: string) =>
		execFileSync("git", args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 1024, input });
	const entries = new Map<string, { id: string; size: number }>();
	for (const line of git(["ls-tree", "-r", "-l", "-z", rev]).toString().split("\0")) {
		const match = /^\d{6} blob ([0-9a-f]{40}) +(\d+)\t(.+)$/.exec(line);
		if (match && !/test\/suite\/context-engine/.test(match[3]))
			entries.set(match[3], { id: match[1], size: Number(match[2]) });
	}
	const files = [...entries.keys()].sort();
	const ids = [...new Set([...entries.values()].map((e) => e.id))];
	const batch = git(["cat-file", "--batch"], `${ids.join("\n")}\n`);
	const blobs = new Map<string, Buffer>();
	let at = 0;
	while (at < batch.length) {
		const eol = batch.indexOf(10, at);
		const [id, , length] = batch.subarray(at, eol).toString().split(" ");
		const size = Number(length);
		blobs.set(id, batch.subarray(eol + 1, eol + 1 + size));
		at = eol + 1 + size + 1;
	}
	// A checkout converts files marked eol=crlf (Windows scripts); read them as a checkout has them.
	const crlf = new Set<string>();
	const attrs = git(["check-attr", `--source=${rev}`, "-z", "--stdin", "eol"], `${files.join("\0")}\0`)
		.toString()
		.split("\0");
	for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === "crlf") crlf.add(attrs[i]);
	const bytes = (path: string): Buffer => {
		const blob = blobs.get(entries.get(path)?.id ?? "");
		if (!blob) throw new Error(`E2: ${path} is not in ${rev}`);
		return crlf.has(path) ? Buffer.from(blob.toString("latin1").replace(/\r?\n/g, "\r\n"), "latin1") : blob;
	};
	return {
		files,
		size: (path) => (crlf.has(path) ? bytes(path).length : entries.get(path)?.size),
		bytes,
	};
}

/** Markdown to plain prose paragraphs: drop code fences, tables, HTML, headings; unwrap links and emphasis. */
function proseParagraphs(markdown: string): string[] {
	const withoutFences = markdown.replace(/```[\s\S]*?```/g, "\n");
	return withoutFences
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter((block) => block.length >= 120 && !/^(#|\||<|-{3}|\s*[-*] \[)/.test(block) && !block.includes("|---"))
		.map((block) =>
			block
				.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
				.replace(/`([^`]+)`/g, "$1")
				.replace(/^\s*[-*+]\s+/gm, "")
				.replace(/^\s*\d+\.\s+/gm, "")
				.replace(/\s*\n\s*/g, " ")
				.trim(),
		)
		.filter((p) => /[a-z]{3,}/.test(p) && p.split(" ").length >= 20);
}

function markdownSections(markdown: string): string[] {
	return markdown
		.split(/\n(?=#{1,4} )/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 200);
}

export function loadCorpus(): Corpus {
	if (cached) return cached;
	const rev = corpusRev();
	const source = rev ? revisionSource(rev) : worktreeSource();
	const files = source.files;
	const hash = createHash("sha256");
	const read = (path: string): Buffer => {
		const bytes = source.bytes(path);
		hash.update(path).update("\0").update(createHash("sha1").update(bytes).digest());
		return bytes;
	};
	const corpus: Corpus = {
		code: [],
		paragraphs: [],
		sections: [],
		html: [],
		json: [],
		images: [],
		binaries: [],
		listing: [],
		fingerprint: "",
	};
	for (const path of files) {
		const size = source.size(path);
		if (size === undefined) continue;
		corpus.listing.push({ path, size });
		hash.update(`L${path}:${size}\0`);
		const ext = path.split(".").pop() ?? "";
		if (size === 0 || size > 300_000) continue;
		if (CODE_EXT[ext]) {
			const text = read(path).toString("utf8");
			corpus.code.push({ path, text, lang: CODE_EXT[ext] });
			if (ext === "html") corpus.html.push(text);
		} else if (ext === "md") {
			const text = read(path).toString("utf8");
			corpus.paragraphs.push(...proseParagraphs(text));
			corpus.sections.push(...markdownSections(text));
		} else if (ext === "json") {
			try {
				corpus.json.push({ path, value: JSON.parse(read(path).toString("utf8")) });
			} catch {}
		}
	}
	for (const path of files) {
		if (/\.png$/.test(path)) {
			const bytes = read(path);
			const width = bytes.readUInt32BE(16);
			const height = bytes.readUInt32BE(20);
			corpus.images.push({ path, data: bytes.toString("base64"), mimeType: "image/png", width, height });
			corpus.binaries.push({ path, bytes });
		} else if (/\.wasm$/.test(path) && (source.size(path) ?? 0) < 8_000_000) {
			corpus.binaries.push({ path, bytes: read(path) });
		}
	}
	if (corpus.code.length < 50 || corpus.paragraphs.length < 50 || corpus.images.length === 0)
		throw new Error(`E2: corpus too small (is ${rev ?? REPO_ROOT} a Pi tree?)`);
	corpus.fingerprint = hash.digest("hex");
	cached = corpus;
	return corpus;
}
