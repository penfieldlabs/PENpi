/**
 * Where the real tokenizers live, and the checks that what gets loaded is what was pinned. Shared by E2 and the
 * engine suite (../context-engine/tokenizers.ts); setup-tokenizers.sh (`npm run setup:tokenizers`) fills it.
 *
 * The cache is inside the repository (context-engine-e2/.cache/, git-ignored), never a shared path: code loaded
 * from a directory another user can write would run inside `npm test`. E2_TOK_DIR and E2_HF_DIR move it.
 *
 * Before anything is require()d, the whole installed npm tree (tok/node_modules) is hashed and compared with
 * tok/install.sha256: one line per file, sorted, "<path>\t<sha256>", hashed again. The GLM files are data, each
 * checked against its own SHA-256 (HF_FILES) before it is read.
 *
 *   node tokenizer-cache.ts digest      prints the installed tree's digest
 *   node tokenizer-cache.ts verify      exits non-zero unless the installed tree matches the pin
 *   node tokenizer-cache.ts hf-files    prints "<file> <sha256>" for the GLM files setup-tokenizers.sh fetches
 *   node tokenizer-cache.ts dirs        prints the npm and GLM directories
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = join(HERE, ".cache");
export const TOK_DIR = resolve(process.env.E2_TOK_DIR ?? join(CACHE_DIR, "tok"));
export const HF_DIR = join(resolve(process.env.E2_HF_DIR ?? join(CACHE_DIR, "hf")), "GLM-5.3-Flash");
/** The command that installs (or repairs) the cache. */
export const SETUP_COMMAND = "npm run setup:tokenizers";

/** GLM-5.3-Flash files at revision 91b69215 (huggingface.co/zai-org/GLM-5.3-Flash), by SHA-256. */
export const HF_FILES: Record<string, string> = {
	"tokenizer.json": "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d",
	"tokenizer_config.json": "98b1271574f41abf89427ae2dda030d94dc9478f0edc5a8bd240db213c6fd5fc",
	"chat_template.jinja": "0c4099f3382d6c92700dfb99725025360966fd73032f0ecf32377c0d9e6309c5",
	"processor_config.json": "aae38374c94b08cc9b0547c6e64f05b951bd9735cea571c6988f5ed552bed3ed",
};

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The pinned digest of tok/node_modules after `npm ci` from tok/package-lock.json. */
export function pinnedInstallDigest(): string {
	return readFileSync(join(HERE, "tok", "install.sha256"), "utf8").trim();
}

/**
 * Digest of an installed npm tree: every entry under node_modules except npm's own .package-lock.json (it
 * records the install, not the code), sorted by path. Symbolic links count by their target.
 */
export function installDigest(dir: string = TOK_DIR): string {
	const root = join(dir, "node_modules");
	const lines: string[] = [];
	const walk = (path: string) => {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name);
			const rel = relative(root, full).split(sep).join("/");
			if (rel === ".package-lock.json") continue;
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) lines.push(`${rel}\t-> ${readlinkSync(full)}`);
			else if (stat.isDirectory()) walk(full);
			else lines.push(`${rel}\t${sha256(readFileSync(full))}`);
		}
	};
	walk(root);
	return sha256(`${lines.join("\n")}\n`);
}

function setupError(problem: string): Error {
	return new Error(`${problem}. Run \`${SETUP_COMMAND}\` from the repository root (tokenizers in ${TOK_DIR}).`);
}

let verified = false;
/** require() from the tokenizer install, after checking that the installed tree matches the pin. */
export function verifiedRequire(): NodeJS.Require {
	if (!verified) {
		if (!existsSync(join(TOK_DIR, "node_modules"))) throw setupError("The tokenizers are not installed");
		const digest = installDigest();
		if (digest !== pinnedInstallDigest())
			throw setupError(`The tokenizer install does not match its pin (digest ${digest.slice(0, 12)})`);
		verified = true;
	}
	return createRequire(join(TOK_DIR, "package.json"));
}

/** A GLM file's bytes, after checking its SHA-256. */
export function verifiedHfFile(name: string): Buffer {
	const expected = HF_FILES[name];
	if (!expected) throw new Error(`E2: no pinned SHA-256 for ${name}`);
	const file = join(HF_DIR, name);
	if (!existsSync(file)) throw setupError(`${file} is missing`);
	const bytes = readFileSync(file);
	const sha = sha256(bytes);
	if (sha !== expected) throw setupError(`${file} has SHA-256 ${sha}, expected ${expected}`);
	return bytes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const command = process.argv[2];
	if (command === "digest") console.log(installDigest());
	else if (command === "verify") {
		const ok = existsSync(join(TOK_DIR, "node_modules")) && installDigest() === pinnedInstallDigest();
		if (!ok) console.error(`tokenizer install in ${TOK_DIR} does not match tok/install.sha256`);
		process.exit(ok ? 0 : 1);
	} else if (command === "hf-files") for (const [name, sha] of Object.entries(HF_FILES)) console.log(`${name} ${sha}`);
	else if (command === "dirs") console.log(`${TOK_DIR}\n${HF_DIR}`);
	else {
		console.error("usage: tokenizer-cache.ts digest | verify | hf-files | dirs");
		process.exit(2);
	}
}
