/**
 * Tokenizer files on disk (0.9.0): the cache folder, downloads from Hugging Face, and the checks before a file is used.
 *
 * - `tokenizer: "auto"` downloads a missing file on first use; `"local"` uses bundled and already-cached files only
 *   and never makes a request; `"estimate"` uses no tokenizer at all. PENPI_TOKENIZER overrides the setting.
 * - A file lives at `<agent dir>/cache/penpi/tokenizers/<sha256>`. It is used only as bytes that were read once and
 *   matched the table's size and SHA-256: TokenizerFiles.file() returns those bytes, in a buffer of their own that the
 *   caller transfers to the worker, so what is loaded is exactly what was hashed. A cached file is checked again on
 *   each use, since the folder is the user's to change: a path that isn't a regular file, or whose size differs, is
 *   refused before anything is read.
 * - The request asks for `Accept-Encoding: identity`, follows at most 5 redirects by hand, each over HTTPS, and goes
 *   through the global `fetch`, so Pi's dispatcher (its proxy settings) applies. A `Content-Length` other than the
 *   pinned size refuses the download; more bytes than the pinned size abort it; the size and hash are checked as the
 *   bytes stream in. Nothing above MAX_TOKENIZER_BYTES is ever written.
 * - Two processes can download at once: each writes its own `.part` file and renames it into place once it hashes
 *   right. On Windows a rename onto a file another process has open fails with EPERM; when the target exists and
 *   hashes right, that is success.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TOKENIZER_BYTES, type TokenizerEntry } from "./table.ts";

export type TokenizerMode = "auto" | "local" | "estimate";

export const TOKENIZER_MODES: readonly TokenizerMode[] = ["auto", "local", "estimate"];

/** Why a model is counted with the estimate. */
export type FallbackReason =
	| "no public tokenizer"
	| "an assumed name (budget only)"
	| "offline"
	| "download failed"
	| "hash mismatch"
	| "tokenizer worker failed"
	| "turned off";

/** The mode: PENPI_TOKENIZER when it names one, else the setting, else "auto". An unknown value warns and is ignored. */
export function tokenizerMode(
	setting: TokenizerMode | undefined,
	env: Record<string, string | undefined>,
	warn?: (message: string) => void,
): TokenizerMode {
	const fromEnv = env.PENPI_TOKENIZER;
	if (fromEnv !== undefined && fromEnv !== "") {
		if ((TOKENIZER_MODES as readonly string[]).includes(fromEnv)) return fromEnv as TokenizerMode;
		warn?.(`ignoring PENPI_TOKENIZER=${JSON.stringify(fromEnv)}: "auto", "local" or "estimate"`);
	}
	return setting ?? "auto";
}

/** The cache folder under Pi's agent directory. */
export function tokenizerCacheDir(agentDir: string): string {
	return join(agentDir, "cache", "penpi", "tokenizers");
}

/** At most this many redirects are followed. */
export const MAX_REDIRECTS = 5;
/** A `.part` file older than this is left from a crash and removed. */
export const STALE_PART_MS = 24 * 60 * 60 * 1000;
/** Bytes read or hashed at a time, so the event loop keeps running. */
const CHUNK = 1 << 20;

export interface TokenizerFilesOptions {
	/** The cache folder (tokenizerCacheDir). */
	dir: string;
	mode: TokenizerMode;
	/** The HTTP client: the global fetch, so Pi's dispatcher applies. Tests pass a stub. */
	fetch?: typeof fetch;
	/** Notices for the user: the first download of an entry. */
	notify?: (message: string) => void;
	/** fs.rename; tests pass a Windows-shaped one. */
	rename?: (from: string, to: string) => Promise<void>;
	/** Distinguishes this process's `.part` files (default: the pid). */
	processTag?: string;
	now?: () => number;
}

/**
 * A tokenizer's verified bytes (in a buffer of their own, to transfer to the worker), "bundled" for o200k and cl100k,
 * or why the estimate is used.
 */
export type TokenizerFile = { bytes: Uint8Array } | { bundled: true } | { fallback: FallbackReason };

/**
 * Opened without following a final link and without waiting on a FIFO's writer (where the platform has those flags),
 * then checked by its handle: a regular file of the entry's size, or undefined. The path can change between a stat
 * and the open; the handle is what is read.
 */
export async function openVerified(path: string, entry: TokenizerEntry): Promise<FileHandle | undefined> {
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	const file = await open(path, flags).catch(() => undefined);
	if (!file) return undefined;
	const info = await file.stat().catch(() => undefined);
	if (info?.isFile() && info.size === entry.size) return file;
	await file.close().catch(() => undefined);
	return undefined;
}

/**
 * A cached file's bytes, read once in 1 MB chunks and hashed as they are read, when the path is a regular file of the
 * entry's size and the bytes match its SHA-256. Undefined otherwise; a path that isn't a regular file, or of another
 * size, is refused before anything is read, by the path and again by the opened handle.
 */
export async function readVerified(path: string, entry: TokenizerEntry): Promise<Uint8Array | undefined> {
	const info = await lstat(path).catch(() => undefined);
	if (!info?.isFile() || info.size !== entry.size) return undefined;
	const file = await openVerified(path, entry);
	if (!file) return undefined;
	const bytes = new Uint8Array(entry.size);
	const hash = createHash("sha256");
	try {
		let at = 0;
		while (at < bytes.length) {
			const { bytesRead } = await file.read(bytes, at, Math.min(CHUNK, bytes.length - at), at);
			if (bytesRead === 0) return undefined;
			hash.update(bytes.subarray(at, at + bytesRead));
			at += bytesRead;
		}
		// Grown since the stat: not the file that was checked.
		const { bytesRead } = await file.read(new Uint8Array(1), 0, 1, at);
		if (bytesRead !== 0) return undefined;
	} catch {
		return undefined;
	} finally {
		await file.close().catch(() => undefined);
	}
	return hash.digest("hex") === entry.sha256 ? bytes : undefined;
}

async function remove(path: string): Promise<void> {
	await unlink(path).catch(() => undefined);
}

function formatSize(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Licenses that need no link in the notice. */
const PLAIN_LICENSES = new Set(["MIT", "Apache-2.0"]);

/** The notice for an entry's first download. Every license other than MIT or Apache-2.0 is linked. */
export function downloadNotice(entry: TokenizerEntry): string {
	const license = PLAIN_LICENSES.has(entry.license) ? "" : `; its license (${entry.license}): ${entry.licenseUrl}`;
	return (
		`context engine: downloading the ${entry.id} tokenizer (${formatSize(entry.size ?? 0)}) from huggingface.co/${entry.repo} ` +
		`at ${entry.revision?.slice(0, 12)}; set \`tokenizer\` to \`local\` or \`estimate\` to stay offline${license}`
	);
}

/** The notice when a model is counted with the estimate. */
export function fallbackNotice(model: string, reason: FallbackReason): string {
	return `context engine: counting ${model} with the estimate (${reason})`;
}

/**
 * The tokenizer files of one session: finds, checks and downloads them. A download that failed or didn't hash right
 * is not tried again in the same session, and a cached file that changed on disk is downloaded again at most once.
 */
export class TokenizerFiles {
	private readonly options: TokenizerFilesOptions;
	private readonly failed = new Map<string, FallbackReason>();
	private readonly inFlight = new Map<string, Promise<TokenizerFile>>();
	private readonly noticed = new Set<string>();
	private readonly downloaded = new Set<string>();
	private cleaned = false;

	constructor(options: TokenizerFilesOptions) {
		this.options = options;
	}

	/**
	 * An entry's verified bytes, or why the estimate is used. Bundled entries need no file. Concurrent callers share one
	 * in-flight read, so they get the same buffer, and a transfer to the worker detaches it for all of them: the bytes
	 * are single-use. The tokenizer counter (counter.ts) is the one caller, and asks again for a restart.
	 */
	async file(entry: TokenizerEntry): Promise<TokenizerFile> {
		if (this.options.mode === "estimate") return { fallback: "turned off" };
		if (entry.loader === "bundled") return { bundled: true };
		const failed = this.failed.get(entry.id);
		if (failed) return { fallback: failed };
		let pending = this.inFlight.get(entry.id);
		if (!pending) {
			pending = this.resolve(entry).finally(() => this.inFlight.delete(entry.id));
			this.inFlight.set(entry.id, pending);
		}
		return pending;
	}

	private async resolve(entry: TokenizerEntry): Promise<TokenizerFile> {
		const { dir, mode } = this.options;
		const target = join(dir, entry.sha256 as string);
		const cached = await lstat(target).catch(() => undefined);
		if (cached) {
			const bytes = await readVerified(target, entry);
			if (bytes) return { bytes };
			// Not a regular file: not ours to remove or replace.
			if (!cached.isFile()) return this.fail(entry, "hash mismatch");
			// Changed on disk since it was written: removed, and downloaded again once per session under "auto".
			await remove(target);
			if (mode === "local" || this.downloaded.has(entry.id)) return this.fail(entry, "hash mismatch");
		}
		if (mode === "local") return { fallback: "offline" };
		return this.download(entry, target);
	}

	private fail(entry: TokenizerEntry, reason: FallbackReason): TokenizerFile {
		this.failed.set(entry.id, reason);
		return { fallback: reason };
	}

	private async download(entry: TokenizerEntry, target: string): Promise<TokenizerFile> {
		const { dir } = this.options;
		if (!entry.size || !entry.sha256 || !entry.repo || !entry.revision || !entry.file)
			return this.fail(entry, "download failed");
		if (entry.size > MAX_TOKENIZER_BYTES) return this.fail(entry, "download failed");
		this.downloaded.add(entry.id);
		await mkdir(dir, { recursive: true });
		await this.cleanStaleParts();
		if (!this.noticed.has(entry.id)) {
			this.noticed.add(entry.id);
			this.options.notify?.(downloadNotice(entry));
		}
		const tag = this.options.processTag ?? String(process.pid);
		const part = join(dir, `${entry.sha256}.${tag}.${randomBytes(6).toString("hex")}.part`);
		try {
			const response = await this.request(
				`https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`,
			);
			if (!response) return this.fail(entry, "download failed");
			const written = await this.write(response, part, entry);
			if (!(written instanceof Uint8Array)) {
				await remove(part);
				return this.fail(entry, written);
			}
			const placed = await this.place(part, target, entry);
			if (!placed) return this.fail(entry, "download failed");
			return { bytes: written };
		} catch {
			await remove(part);
			return this.fail(entry, "download failed");
		}
	}

	/** GET with redirects followed by hand: HTTPS on every hop, at most MAX_REDIRECTS. Undefined on any refusal. */
	private async request(url: string): Promise<Response | undefined> {
		const get = this.options.fetch ?? fetch;
		let current = new URL(url);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			if (current.protocol !== "https:") return undefined;
			const response = await get(current.href, {
				headers: { "Accept-Encoding": "identity" },
				redirect: "manual",
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => undefined);
				if (!location) return undefined;
				// A relative location is resolved against the current URL.
				current = new URL(location, current);
				continue;
			}
			return response.ok ? response : undefined;
		}
		return undefined;
	}

	/**
	 * The body into `part` and into a buffer of the pinned size, hashed as it streams. Returns the buffer when the size
	 * and hash match; refused or aborted on any mismatch.
	 */
	private async write(response: Response, part: string, entry: TokenizerEntry): Promise<Uint8Array | FallbackReason> {
		const encoding = response.headers.get("content-encoding");
		const length = response.headers.get("content-length");
		// A length of an encoded body is the encoded size; the decoded bytes are what is counted.
		const identity = encoding === null || encoding === "identity";
		if (identity && length !== null && Number(length) !== entry.size) {
			await response.body?.cancel().catch(() => undefined);
			return "download failed";
		}
		if (!response.body) return "download failed";
		const size = entry.size as number;
		const bytes = new Uint8Array(size);
		const hash = createHash("sha256");
		let at = 0;
		const file = await open(part, "wx");
		try {
			const reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (at + value.length > size) {
					await reader.cancel().catch(() => undefined);
					return "download failed";
				}
				bytes.set(value, at);
				at += value.length;
				hash.update(value);
				await file.write(value);
			}
		} finally {
			await file.close();
		}
		if (at !== size) return "download failed";
		return hash.digest("hex") === entry.sha256 ? bytes : "hash mismatch";
	}

	/** Rename `part` into place. A rename refused because another process holds or made the file is success when it hashes right. */
	private async place(part: string, target: string, entry: TokenizerEntry): Promise<boolean> {
		const move = this.options.rename ?? rename;
		try {
			await move(part, target);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			await remove(part);
			return (code === "EPERM" || code === "EEXIST") && (await readVerified(target, entry)) !== undefined;
		}
	}

	/** `.part` files older than a day are left from a crash. Once per session. */
	private async cleanStaleParts(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		const now = (this.options.now ?? Date.now)();
		for (const name of await readdir(this.options.dir).catch(() => [] as string[])) {
			if (!name.endsWith(".part")) continue;
			const path = join(this.options.dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info && now - info.mtimeMs > STALE_PART_MS) await remove(path);
		}
	}
}
