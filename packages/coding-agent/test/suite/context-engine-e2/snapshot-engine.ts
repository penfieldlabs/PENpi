/**
 * Snapshot of the engine under test: the entry file and every file it reaches through relative imports,
 * copied byte-for-byte into context-engine-e2/.engine/<sha12>/ with their layout kept, so every worker of a matrix
 * run loads the same bytes even if the sources are edited meanwhile. The engine is a module directory
 * (.pi/extensions/penpi/engine), so a snapshot is a set of files.
 *
 * The id is the SHA-256 of the entry file when it imports nothing relative (the single-file engines of the
 * prototype keep their ids), and otherwise the SHA-256 of the manifest: one line per file, sorted by path,
 * "<path relative to the common root>\t<sha256 of its bytes>".
 *
 *   node snapshot-engine.ts <entry.ts>    prints "<sha256>\t<snapshot entry path>\t<file count>"
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = join(HERE, ".engine");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Relative specifiers of static imports, re-exports and dynamic imports. */
function relativeImports(source: string): string[] {
	const out = new Set<string>();
	for (const m of source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?\sfrom\s*["'](\.{1,2}\/[^"']+)["']/g))
		out.add(m[1]);
	for (const m of source.matchAll(/(?:^|[\s;])import\s*["'](\.{1,2}\/[^"']+)["']/g)) out.add(m[1]);
	for (const m of source.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) out.add(m[1]);
	return [...out];
}

/** The entry file and every file it reaches through relative imports (absolute paths, sorted). */
export function engineFiles(entry: string): string[] {
	const seen = new Set<string>();
	const queue = [resolve(entry)];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`E2: engine import ${file} not found`);
		seen.add(file);
		for (const spec of relativeImports(readFileSync(file, "utf8"))) queue.push(resolve(dirname(file), spec));
	}
	return [...seen].sort();
}

function commonRoot(files: string[]): string {
	let root = dirname(files[0]);
	while (!files.every((f) => f.startsWith(root + sep))) root = dirname(root);
	return root;
}

export interface EngineSnapshot {
	/** The snapshot's copy of the entry file. */
	entry: string;
	sha: string;
	dir: string;
	files: number;
}

/** Snapshot the engine whose entry file is `entry`; returns the snapshot's entry path and id. */
export function snapshotEngine(entry: string): EngineSnapshot {
	const source = resolve(entry);
	// Already a snapshot: verify it and use it as it is.
	if (source.startsWith(SNAPSHOTS + sep)) {
		const dir = join(SNAPSHOTS, relative(SNAPSHOTS, source).split(sep)[0]);
		const manifest = join(dir, "MANIFEST");
		const sha = existsSync(manifest) ? sha256(readFileSync(manifest)) : sha256(readFileSync(source));
		if (existsSync(manifest))
			for (const line of readFileSync(manifest, "utf8").trim().split("\n")) {
				const [path, fileSha] = line.split("\t");
				if (sha256(readFileSync(join(dir, path))) !== fileSha) throw new Error(`E2: snapshot file ${path} changed`);
			}
		return {
			entry: source,
			sha,
			dir,
			files: existsSync(manifest) ? readFileSync(manifest, "utf8").trim().split("\n").length : 1,
		};
	}
	const files = engineFiles(source);
	const root = commonRoot(files);
	const bytes = new Map(files.map((f) => [f, readFileSync(f)] as const));
	const of = (f: string) => bytes.get(f) as Buffer;
	const lines = files.map((f) => `${relative(root, f).split(sep).join("/")}\t${sha256(of(f))}`);
	const manifest = `${lines.join("\n")}\n`;
	const sha = files.length === 1 ? sha256(of(source)) : sha256(manifest);
	const dir = join(SNAPSHOTS, sha.slice(0, 12));
	for (const f of files) {
		const target = join(dir, relative(root, f));
		if (existsSync(target) && sha256(readFileSync(target)) === sha256(of(f))) continue;
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(`${target}.part`, of(f));
		renameSync(`${target}.part`, target);
	}
	if (files.length > 1) writeFileSync(join(dir, "MANIFEST"), manifest);
	writeFileSync(join(dir, "SOURCE"), `${source}\n`);
	// The sources must not have changed while they were read and copied.
	for (const f of files)
		if (
			sha256(readFileSync(f)) !== sha256(of(f)) ||
			sha256(readFileSync(join(dir, relative(root, f)))) !== sha256(of(f))
		)
			throw new Error(`E2: ${f} changed while it was copied; retry`);
	return { entry: join(dir, relative(root, source)), sha, dir, files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const entry = process.argv[2];
	if (!entry) {
		console.error("usage: snapshot-engine.ts <entry.ts>");
		process.exit(2);
	}
	try {
		const snap = snapshotEngine(entry);
		console.log(`${snap.sha}\t${snap.entry}\t${snap.files}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(3);
	}
}
