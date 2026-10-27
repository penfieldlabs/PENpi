/**
 * Real tokenizers for the engine tests: OpenAI o200k_base via js-tiktoken, from the tokenizer cache that
 * `npm run setup:tokenizers` fills (../context-engine-e2/tokenizer-cache.ts), checked against its pin before it
 * is loaded.
 */
import { verifiedRequire } from "../context-engine-e2/tokenizer-cache.ts";

const require = verifiedRequire();
const { Tiktoken } = require("js-tiktoken/lite") as {
	Tiktoken: new (ranks: unknown) => { encode(text: string, allowed: "all"): number[] };
};
const ranks = require("js-tiktoken/ranks/o200k_base") as { default?: unknown };
const o200k = new Tiktoken(ranks.default ?? ranks);

export function o200kTokens(text: string): number {
	return o200k.encode(text, "all").length;
}
