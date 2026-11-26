import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	downloadNotice,
	fallbackNotice,
	MAX_REDIRECTS,
	openVerified,
	readVerified,
	STALE_PART_MS,
	TokenizerFiles,
	type TokenizerFilesOptions,
	tokenizerCacheDir,
	tokenizerMode,
} from "./download.ts";
import { DOWNLOADED, type TokenizerEntry, tokenizerEntry } from "./table.ts";

// Downloads in these tests come from a stub, never from Hugging Face.
const BODY = Buffer.from(`{"model":{"vocab":{}},"note":"${"x".repeat(4_000)}"}`);
const ENTRY: TokenizerEntry = {
	id: "stub",
	loader: "hf",
	repo: "example/stub",
	revision: "0123456789abcdef0123456789abcdef01234567",
	file: "tokenizer.json",
	size: BODY.length,
	sha256: createHash("sha256").update(BODY).digest("hex"),
	license: "MIT",
	licenseUrl: "https://example.invalid/LICENSE",
};
const URL0 = `https://huggingface.co/${ENTRY.repo}/resolve/${ENTRY.revision}/${ENTRY.file}`;
/** What file() gives for a good file: its bytes, read once and verified. */
const GOOD = { bytes: new Uint8Array(BODY) };

interface Call {
	url: string;
	init?: RequestInit;
}

/** A fetch stub serving `routes` by URL; anything else is a 404. */
function stub(routes: Record<string, () => Response>): typeof fetch & { calls: Call[] } {
	const calls: Call[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const route = routes[url];
		return route ? route() : new Response("not found", { status: 404 });
	}) as typeof fetch & { calls: Call[] };
	f.calls = calls;
	return f;
}

const ok = (body: Uint8Array = BODY, headers: Record<string, string> = { "content-length": String(BODY.length) }) =>
	new Response(body, { status: 200, headers });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

let dir: string;
let notices: string[];

beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "penpi-tok-")), "cache", "penpi", "tokenizers");
	notices = [];
});
afterEach(() => rmSync(join(dir, "..", "..", ".."), { recursive: true, force: true }));

function files(options: Partial<TokenizerFilesOptions> = {}) {
	return new TokenizerFiles({ dir, mode: "auto", notify: (m) => notices.push(m), ...options });
}

const leftovers = () => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".part")) : []);

describe("tokenizer files: the setting and the folder", () => {
	it("PENPI_TOKENIZER overrides the setting, and auto is the default", () => {
		expect(tokenizerMode(undefined, {})).toBe("auto");
		expect(tokenizerMode("local", {})).toBe("local");
		expect(tokenizerMode("auto", { PENPI_TOKENIZER: "estimate" })).toBe("estimate");
		const warnings: string[] = [];
		expect(tokenizerMode("local", { PENPI_TOKENIZER: "nonsense" }, (w) => warnings.push(w))).toBe("local");
		expect(warnings).toEqual(['ignoring PENPI_TOKENIZER="nonsense": "auto", "local" or "estimate"']);
	});

	it("lives under the agent directory", () => {
		expect(tokenizerCacheDir("/a")).toBe(join("/a", "cache", "penpi", "tokenizers"));
	});

	it("bundled entries need no file; estimate uses none", async () => {
		const f = stub({});
		expect(await files({ fetch: f }).file(tokenizerEntry("o200k") as TokenizerEntry)).toEqual({ bundled: true });
		expect(await files({ fetch: f, mode: "estimate" }).file(ENTRY)).toEqual({ fallback: "turned off" });
		expect(f.calls).toEqual([]);
	});
});

describe("tokenizer files: downloads", () => {
	it("downloads once, with the notice, and then uses the cached file", async () => {
		const f = stub({ [URL0]: () => ok() });
		const tf = files({ fetch: f });
		expect(await tf.file(ENTRY)).toEqual(GOOD);
		expect(readFileSync(join(dir, ENTRY.sha256 as string))).toEqual(BODY);
		expect(await tf.file(ENTRY)).toEqual(GOOD);
		expect(await files({ fetch: f }).file(ENTRY)).toEqual(GOOD);
		expect(f.calls.length).toBe(1);
		expect(f.calls[0].init?.headers).toEqual({ "Accept-Encoding": "identity" });
		expect(f.calls[0].init?.redirect).toBe("manual");
		expect(notices).toEqual([downloadNotice(ENTRY)]);
		expect(leftovers()).toEqual([]);
	});

	it("the notice names the entry, its size, the repo and the revision, and links every license but MIT and Apache-2.0", () => {
		expect(downloadNotice(ENTRY)).toBe(
			"context engine: downloading the stub tokenizer (0.0 MB) from huggingface.co/example/stub at 0123456789ab; set `tokenizer` to `local` or `estimate` to stay offline",
		);
		const nvidia = tokenizerEntry("nemotron3") as TokenizerEntry;
		expect(downloadNotice(nvidia)).toContain("(17.1 MB)");
		expect(downloadNotice(nvidia)).toContain(
			`its license (NVIDIA Nemotron Open Model License): ${nvidia.licenseUrl}`,
		);
		for (const id of ["nemotron35vl", "kimi", "minimax-m2"]) {
			const e = tokenizerEntry(id) as TokenizerEntry;
			expect(downloadNotice(e), id).toContain(`its license (${e.license}): ${e.licenseUrl}`);
		}
		for (const id of ["qwen3", "glm5", "gemma4"])
			expect(downloadNotice(tokenizerEntry(id) as TokenizerEntry), id).not.toContain("its license");
		expect(fallbackNotice("glm-5", "offline")).toBe("context engine: counting glm-5 with the estimate (offline)");
	});

	it("follows a relative redirect and a redirect to another host, over HTTPS", async () => {
		const cdn = "https://cdn.example/abc";
		const f = stub({
			[URL0]: () => redirect("/api/resolve-cache/x"),
			"https://huggingface.co/api/resolve-cache/x": () => redirect(cdn),
			[cdn]: () => ok(),
		});
		expect(await files({ fetch: f }).file(ENTRY)).toEqual(GOOD);
		expect(f.calls.map((c) => c.url)).toEqual([URL0, "https://huggingface.co/api/resolve-cache/x", cdn]);
	});

	it("refuses an HTTP hop", async () => {
		const f = stub({ [URL0]: () => redirect("http://cdn.example/abc"), "http://cdn.example/abc": () => ok() });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual({ fallback: "download failed" });
		expect(f.calls.length).toBe(1);
	});

	it(`refuses a redirect past the ${MAX_REDIRECTS}th`, async () => {
		const routes: Record<string, () => Response> = { [URL0]: () => redirect("https://h.example/1") };
		for (let i = 1; i <= MAX_REDIRECTS + 1; i++)
			routes[`https://h.example/${i}`] = () => redirect(`https://h.example/${i + 1}`);
		const f = stub(routes);
		expect(await files({ fetch: f }).file(ENTRY)).toEqual({ fallback: "download failed" });
		expect(f.calls.length).toBe(MAX_REDIRECTS + 1);
	});

	it("refuses a Content-Length other than the pinned size, and writes nothing", async () => {
		const f = stub({ [URL0]: () => ok(BODY, { "content-length": String(BODY.length + 1) }) });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual({ fallback: "download failed" });
		expect(existsSync(join(dir, ENTRY.sha256 as string))).toBe(false);
		expect(leftovers()).toEqual([]);
	});

	it("allows a missing Content-Length", async () => {
		const f = stub({ [URL0]: () => ok(BODY, {}) });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual(GOOD);
	});

	it("counts the decoded bytes of an encoded body, not its Content-Length", async () => {
		// As a gzip response arrives through fetch: the body decoded, the headers as sent.
		const f = stub({ [URL0]: () => ok(BODY, { "content-encoding": "gzip", "content-length": "1234" }) });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual(GOOD);
	});

	it("aborts a body longer than the pinned size", async () => {
		const f = stub({ [URL0]: () => ok(Buffer.concat([BODY, Buffer.from("more")]), {}) });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual({ fallback: "download failed" });
		expect(leftovers()).toEqual([]);
		expect(existsSync(join(dir, ENTRY.sha256 as string))).toBe(false);
	});

	it("a hash mismatch deletes the file and is not tried again in the session", async () => {
		const wrong = Buffer.from(BODY);
		wrong[10] ^= 1;
		const f = stub({ [URL0]: () => ok(wrong) });
		const tf = files({ fetch: f });
		expect(await tf.file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		expect(await tf.file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		expect(f.calls.length).toBe(1);
		expect(existsSync(join(dir, ENTRY.sha256 as string))).toBe(false);
		expect(leftovers()).toEqual([]);
	});

	it("a download error or a 404 leaves the estimate", async () => {
		const failing = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await files({ fetch: failing }).file(ENTRY)).toEqual({ fallback: "download failed" });
		expect(await files({ fetch: stub({}) }).file(ENTRY)).toEqual({ fallback: "download failed" });
		expect(leftovers()).toEqual([]);
	});

	it("never downloads a file over the cap", async () => {
		const f = stub({});
		expect(await files({ fetch: f }).file({ ...ENTRY, size: 33 * 1024 * 1024 })).toEqual({
			fallback: "download failed",
		});
		expect(f.calls).toEqual([]);
		for (const e of DOWNLOADED) expect(e.size).toBeLessThanOrEqual(32 * 1024 * 1024);
	});
});

describe("tokenizer files: two processes, Windows, the cache on disk", () => {
	it("two processes downloading at once each write their own .part and end with one good file", async () => {
		const f = stub({ [URL0]: () => ok() });
		const [a, b] = await Promise.all([
			files({ fetch: f, processTag: "100" }).file(ENTRY),
			files({ fetch: f, processTag: "200" }).file(ENTRY),
		]);
		expect(a).toEqual(GOOD);
		expect(b).toEqual(a);
		expect(f.calls.length).toBe(2);
		expect(readdirSync(dir)).toEqual([ENTRY.sha256]);
	});

	it("a Windows EPERM or EEXIST on the rename is success when the target hashes right", async () => {
		for (const code of ["EPERM", "EEXIST"]) {
			rmSync(dir, { recursive: true, force: true });
			// Another process renamed its good copy into place first, and holds it open.
			const windows = async (_from: string, to: string) => {
				writeFileSync(to, BODY);
				throw Object.assign(new Error(code), { code });
			};
			expect(await files({ fetch: stub({ [URL0]: () => ok() }), rename: windows }).file(ENTRY), code).toEqual(GOOD);
			expect(leftovers(), code).toEqual([]);
		}
	});

	it("a Windows EPERM with no good target is a failure", async () => {
		const windows = async () => {
			throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		};
		expect(await files({ fetch: stub({ [URL0]: () => ok() }), rename: windows }).file(ENTRY)).toEqual({
			fallback: "download failed",
		});
		expect(leftovers()).toEqual([]);
	});

	it("the bytes returned are the ones hashed, in a buffer of their own to transfer to the worker", async () => {
		const tf = files({ fetch: stub({ [URL0]: () => ok() }) });
		for (const got of [await tf.file(ENTRY), await files().file(ENTRY)]) {
			const bytes = (got as { bytes: Uint8Array }).bytes;
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(ENTRY.sha256);
			expect([bytes.byteOffset, bytes.buffer.byteLength]).toEqual([0, BODY.length]);
		}
	});

	it("a cached path that isn't a regular file is refused before it is read, and not replaced", async () => {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, ENTRY.sha256 as string);
		const f = stub({ [URL0]: () => ok() });
		mkdirSync(target);
		expect(await files({ fetch: f }).file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		rmSync(target, { recursive: true });
		// A link to a good copy is not a regular file either.
		writeFileSync(join(dir, "elsewhere"), BODY);
		symlinkSync(join(dir, "elsewhere"), target);
		expect(await files({ fetch: f }).file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		expect(await readVerified(target, ENTRY)).toBeUndefined();
		expect(f.calls).toEqual([]);
	});

	it("the opened handle is checked too: a FIFO or a link reached at open is refused at once, never waited on", async () => {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, ENTRY.sha256 as string);
		// A path that passed a stat and became a link or a FIFO before the open: the handle check refuses it.
		writeFileSync(join(dir, "elsewhere"), BODY);
		symlinkSync(join(dir, "elsewhere"), target);
		expect(await openVerified(target, ENTRY)).toBeUndefined();
		rmSync(target);
		if (process.platform !== "win32") {
			execFileSync("mkfifo", [target]);
			const started = performance.now();
			expect(await openVerified(target, ENTRY)).toBeUndefined();
			expect(performance.now() - started).toBeLessThan(1000);
			rmSync(target);
		}
		// A regular file of another size, by its handle.
		writeFileSync(target, "short");
		expect(await openVerified(target, ENTRY)).toBeUndefined();
		writeFileSync(target, BODY);
		const file = await openVerified(target, ENTRY);
		expect(file).toBeDefined();
		await file?.close();
	});

	it("a cached file of the wrong size is refused at once, without hashing it, and downloaded again", async () => {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, ENTRY.sha256 as string);
		// 2 GB, sparse: hashing it would take seconds.
		writeFileSync(target, "");
		truncateSync(target, 2 * 1024 ** 3);
		const started = performance.now();
		expect(await readVerified(target, ENTRY)).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(200);
		const f = stub({ [URL0]: () => ok() });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual(GOOD);
		expect(f.calls.length).toBe(1);
	});

	it("a cached file that changes again after its re-download is the estimate: one re-download per session", async () => {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, ENTRY.sha256 as string);
		writeFileSync(target, "tampered");
		const f = stub({ [URL0]: () => ok() });
		const tf = files({ fetch: f });
		expect(await tf.file(ENTRY)).toEqual(GOOD);
		writeFileSync(target, "tampered again");
		expect(await tf.file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		expect(await tf.file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		expect(f.calls.length).toBe(1);
	});

	it("a cached file changed on disk is fetched again once under auto, and refused under local", async () => {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, ENTRY.sha256 as string);
		writeFileSync(target, "tampered");
		const f = stub({ [URL0]: () => ok() });
		expect(await files({ fetch: f }).file(ENTRY)).toEqual(GOOD);
		expect(f.calls.length).toBe(1);
		writeFileSync(target, "tampered");
		expect(await files({ fetch: f, mode: "local" }).file(ENTRY)).toEqual({ fallback: "hash mismatch" });
		expect(existsSync(target)).toBe(false);
		expect(f.calls.length).toBe(1);
	});

	it("removes .part files older than a day and keeps fresh ones", async () => {
		mkdirSync(dir, { recursive: true });
		const old = join(dir, "dead.1.aaaa.part");
		const fresh = join(dir, "live.2.bbbb.part");
		writeFileSync(old, "x");
		writeFileSync(fresh, "y");
		const then = (Date.now() - STALE_PART_MS - 60_000) / 1000;
		utimesSync(old, then, then);
		await files({ fetch: stub({ [URL0]: () => ok() }) }).file(ENTRY);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("reads and hashes a file without blocking the event loop: the longest gap between 1 ms ticks under 50 ms", async () => {
		mkdirSync(dir, { recursive: true });
		const big = join(dir, "big");
		// The size of the largest file in the table.
		const content = Buffer.alloc(32 * 1024 * 1024, 7);
		writeFileSync(big, content);
		const entry = { ...ENTRY, size: content.length, sha256: createHash("sha256").update(content).digest("hex") };
		// The longest gap between 1 ms ticks while it reads, best of three: a synchronous read or hash of the file would
		// block every run, where other test files running at once only stretch some.
		const gaps: number[] = [];
		for (let run = 0; run < 3; run++) {
			let last = performance.now();
			let longest = 0;
			let ticks = 0;
			const timer = setInterval(() => {
				const now = performance.now();
				longest = Math.max(longest, now - last);
				last = now;
				ticks++;
			}, 1);
			const got = await readVerified(big, entry);
			clearInterval(timer);
			gaps.push(Math.max(longest, performance.now() - last));
			expect(got?.length).toBe(content.length);
			expect(ticks).toBeGreaterThan(0);
		}
		const longest = Math.min(...gaps);
		expect(longest, `gaps ${gaps.map((g) => Math.round(g)).join(", ")} ms`).toBeLessThan(50);
	});
});

describe("tokenizer files: local makes no request at all", () => {
	it("a missing file under local is the estimate, with fetch never called", async () => {
		const throwing = (async () => {
			throw new Error("local must not fetch");
		}) as unknown as typeof fetch;
		let called = 0;
		const counting = (async (...args: Parameters<typeof fetch>) => {
			called++;
			return throwing(...args);
		}) as typeof fetch;
		expect(await files({ fetch: counting, mode: "local" }).file(ENTRY)).toEqual({ fallback: "offline" });
		expect(called).toBe(0);
		expect(notices).toEqual([]);
	});

	it("a cached good file under local is used, with fetch never called", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ENTRY.sha256 as string), BODY);
		let called = 0;
		const counting = (async () => {
			called++;
			throw new Error("local must not fetch");
		}) as unknown as typeof fetch;
		expect(await files({ fetch: counting, mode: "local" }).file(ENTRY)).toEqual(GOOD);
		expect(called).toBe(0);
	});

	it("the default client is the global fetch, so Pi's dispatcher applies", async () => {
		const saved = globalThis.fetch;
		const f = stub({ [URL0]: () => ok() });
		globalThis.fetch = f;
		try {
			expect(await files().file(ENTRY)).toEqual(GOOD);
			expect(f.calls.length).toBe(1);
		} finally {
			globalThis.fetch = saved;
		}
	});
});
