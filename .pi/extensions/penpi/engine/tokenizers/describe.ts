/**
 * What the tokenizer worker needs besides an entry's bytes (0.9.0): its prior counting rate, and for Kimi's
 * tiktoken.model, the split pattern and special tokens the file doesn't carry.
 */
import type { WorkerEntry } from "./counter.ts";
import type { TokenizerEntry } from "./table.ts";

/**
 * Prior counting rates, in tokens per millisecond on one machine (design section 2; the release notes' table). The
 * worker measures its own rate from its first chunks, so chunk sizes and deadlines then follow the user's machine.
 */
export const TOKENS_PER_MS: Record<string, number> = {
	// Design section 2: o200k and GLM from three runs, Gemma 4 from review's.
	o200k: 100,
	glm5: 190,
	glm45: 190,
	gemma4: 25,
	// Measured for 0.9.0's commit 4, one run each under the lock: 4 MB of the repository's TypeScript and Markdown in
	// 2,500-character messages, rounded down to 5.
	cl100k: 60,
	kimi: 110,
	inkling: 100,
	"inkling2-small": 95,
	nemotron3: 105,
	nemotron3nano: 115,
	nemotron35vl: 110,
	mistral3: 115,
	"mistral-large3": 120,
	"mistral-small31": 105,
	qwen35: 85,
	qwen38: 80,
};
/** For an entry not measured: the slowest measured family. */
export const DEFAULT_TOKENS_PER_MS = 25;
/** Characters per token, to turn a token rate into the worker's character rate. */
export const CHARS_PER_TOKEN = 4;

/**
 * Kimi's split pattern (tokenization_kimi.py at the table's revision), written for JavaScript, whose regular
 * expressions without the `v` flag have no class intersection and no inline flags:
 * - `[\p{Han}]` is `\p{sc=Han}`;
 * - `[X&&[^\p{Han}]]` is `(?:(?!\p{sc=Han})[X])`;
 * - `(?i:'s|'t|'re|'ve|'m|'ll|'d)` spells out what each letter matches under Unicode case folding: its two cases,
 *   and for "s" the long s, U+017F.
 */
const CONTRACTION = "(?:'[sSſ]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])";
const UPPER = "(?:(?!\\p{sc=Han})[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}])";
const LOWER = "(?:(?!\\p{sc=Han})[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}])";
export const KIMI_PATTERN = [
	"[\\p{sc=Han}]+",
	`[^\\r\\n\\p{L}\\p{N}]?${UPPER}*${LOWER}+${CONTRACTION}?`,
	`[^\\r\\n\\p{L}\\p{N}]?${UPPER}+${LOWER}*${CONTRACTION}?`,
	"\\p{N}{1,3}",
	" ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*",
	"\\s*[\\r\\n]+",
	"\\s+(?!\\S)",
	"\\s+",
].join("|");

/** Kimi's 256 special tokens from id 163,584: the named ones (tokenizer_config.json), the rest reserved. */
const KIMI_NAMED: Record<number, string> = {
	163584: "[BOS]",
	163585: "[EOS]",
	163586: "<|im_end|>",
	163587: "<|im_user|>",
	163588: "<|im_assistant|>",
	163590: "<|start_header_id|>",
	163591: "<|end_header_id|>",
	163593: "[EOT]",
	163594: "<|im_system|>",
	163595: "<|tool_calls_section_begin|>",
	163596: "<|tool_calls_section_end|>",
	163597: "<|tool_call_begin|>",
	163598: "<|tool_call_argument_begin|>",
	163599: "<|tool_call_end|>",
	163601: "<|im_middle|>",
	163838: "[UNK]",
	163839: "[PAD]",
};
export const KIMI_BASE_TOKENS = 163_584;

export function kimiSpecials(): Record<string, number> {
	const out: Record<string, number> = {};
	for (let id = KIMI_BASE_TOKENS; id < KIMI_BASE_TOKENS + 256; id++)
		out[KIMI_NAMED[id] ?? `<|reserved_token_${id}|>`] = id;
	return out;
}

export function describeEntry(entry: TokenizerEntry): WorkerEntry {
	const rate = TOKENS_PER_MS[entry.id] ?? DEFAULT_TOKENS_PER_MS;
	return {
		id: entry.id,
		loader: entry.loader,
		charsPerMs: rate * CHARS_PER_TOKEN,
		...(entry.loader === "tiktoken" ? { pattern: KIMI_PATTERN, specials: kimiSpecials() } : {}),
	};
}
