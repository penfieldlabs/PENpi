/**
 * Real tokenizers for E2, from the cache `npm run setup:tokenizers` fills (tokenizer-cache.ts: repo-local,
 * checked against its pins before anything is loaded):
 *   o200k   js-tiktoken o200k_base (OpenAI GPT-4o / GPT-4.1 / o-series)
 *   glm     GLM-5.3-Flash tokenizer.json from huggingface.co/zai-org/GLM-5.3-Flash (@huggingface/tokenizers)
 * Both encoders treat the special-token strings they know as single tokens, as a server does when it
 * tokenizes a rendered chat template.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HF_FILES, TOK_DIR, verifiedHfFile, verifiedRequire } from "./tokenizer-cache.ts";

export type TokenizerName = "o200k" | "glm";
export const TOKENIZERS: TokenizerName[] = ["o200k", "glm"];

export interface Tokenizer {
	name: TokenizerName;
	/** Library and file the counts come from (for the report). */
	source: string;
	count(text: string): number;
}

function packageVersion(name: string): string {
	return (JSON.parse(readFileSync(join(TOK_DIR, "node_modules", name, "package.json"), "utf8")) as { version: string })
		.version;
}

let o200k: Tokenizer | undefined;
let glm: Tokenizer | undefined;

function loadO200k(): Tokenizer {
	const require = verifiedRequire();
	const { Tiktoken } = require("js-tiktoken/lite") as {
		Tiktoken: new (ranks: unknown) => { encode(text: string, allowed: "all"): number[] };
	};
	const ranks = require("js-tiktoken/ranks/o200k_base") as { default?: unknown };
	const version = packageVersion("js-tiktoken");
	const encoder = new Tiktoken(ranks.default ?? ranks);
	return {
		name: "o200k",
		source: `js-tiktoken ${version} o200k_base`,
		count: (text) => encoder.encode(text, "all").length,
	};
}

async function loadGlm(): Promise<Tokenizer> {
	const raw = verifiedHfFile("tokenizer.json");
	const sha = HF_FILES["tokenizer.json"];
	const require = verifiedRequire();
	// The package's CommonJS build (its "node"/"require" export).
	const { Tokenizer: HfTokenizer } = require("@huggingface/tokenizers") as {
		Tokenizer: new (
			json: unknown,
			config: unknown,
		) => { encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] } };
	};
	const version = packageVersion("@huggingface/tokenizers");
	const config = JSON.parse(verifiedHfFile("tokenizer_config.json").toString("utf8"));
	const encoder = new HfTokenizer(JSON.parse(raw.toString("utf8")), config);
	return {
		name: "glm",
		source: `@huggingface/tokenizers ${version}, GLM-5.3-Flash tokenizer.json sha256 ${sha.slice(0, 12)}`,
		count: (text) => encoder.encode(text, { add_special_tokens: false }).ids.length,
	};
}

export async function loadTokenizer(name: TokenizerName): Promise<Tokenizer> {
	if (name === "o200k") {
		o200k ??= loadO200k();
		return o200k;
	}
	glm ??= await loadGlm();
	return glm;
}

/**
 * Counting with a per-text memo: requests repeat almost every message of the previous request, and the
 * segments are tokenized independently (each starts and ends at a special token), so a request's count
 * is the sum of its segments' counts.
 */
export class CountingTokenizer {
	private memo = new Map<string, number>();
	calls = 0;
	chars = 0;
	ms = 0;
	readonly tokenizer: Tokenizer;
	constructor(tokenizer: Tokenizer) {
		this.tokenizer = tokenizer;
	}
	count(text: string): number {
		if (text.length === 0) return 0;
		const key = text.length < 64 ? text : `${text.length}:${createHash("sha1").update(text).digest("base64")}`;
		const hit = this.memo.get(key);
		if (hit !== undefined) return hit;
		const started = performance.now();
		const n = this.tokenizer.count(text);
		this.ms += performance.now() - started;
		this.calls++;
		this.chars += text.length;
		this.memo.set(key, n);
		return n;
	}
}
