/**
 * Which tokenizer entry (table.ts) counts a catalogue model, from its id. The first rule that matches the lower-cased
 * id wins. The order matters: a generation is matched before its family, and the names that have no entry are
 * matched before the family pattern would take them.
 *
 * - "exact": the entry counts the model for the budget and for detection.
 * - "assumed": a closed or API-only name placed by its generation, an alias that can move to a new file, or a
 *   generation no published mapping names. It counts exactly for the budget; detection stays on the fallback rules
 *   until the name is confirmed by a provider doc, a count API, or a measured match on known content.
 * - "none": no file. The model stays on the estimate.
 * - "out": a file exists, but it is left out (its license, or the owner's decision).
 * - "gated": the file needs an account and an accepted license to download.
 */

export type TokenizerStatus = "exact" | "assumed" | "none" | "out" | "gated";

export interface TokenizerClass {
	status: TokenizerStatus;
	/** The entry id, for "exact" and "assumed". */
	entry?: string;
	/** Why there is no entry, for "none", "out" and "gated". */
	reason?: string;
}

type Target = string | { status: "none" | "out" | "gated"; reason: string };

const none = (reason: string): Target => ({ status: "none", reason });
const out = (reason: string): Target => ({ status: "out", reason });
const gated = (reason: string): Target => ({ status: "gated", reason });

const ALIAS = "an alias that names no generation";
const TEKKEN = "a tekken.json file, which @huggingface/tokenizers can't read";

const RULES: Array<[RegExp, Target]> = [
	[/claude|anthropic/, none("no public tokenizer (Claude)")],
	[/gemini|deep-research/, none("no public tokenizer (Gemini)")],
	[/gemma-4/, "gemma4"],
	[/gemma-3/, gated("Gemma 3")],
	[/minimax-m3/, out("MiniMax M3's license")],
	[/minimax-m1/, "minimax-m1"],
	[/minimax-m2/, "minimax-m2"],
	[/minimax-latest/, none(ALIAS)],
	[/grok/, none("no public tokenizer (Grok)")],
	[/gpt-oss/, "o200k"],
	[/gpt-4(?![o.\d])|gpt-4-|gpt-3\.5|gpt-35/, "cl100k"],
	[/gpt-5-chat-latest/, "o200k"],
	[/gpt-6|gpt-daybreak|chat-latest/, none("no public tokenizer (OpenAI after GPT-5)")],
	[/gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|(^|[/.])o[134](-|$)|codex|chatgpt|computer-use|gpt-realtime|gpt-audio/, "o200k"],
	[/qwen-?4/, none("no file (Qwen 4)")],
	[/qwen-?3[.p]8/, "qwen38"],
	[/qwen-?3\.7/, none("no file (Qwen 3.7)")],
	[/qwen-?3\.[56]/, "qwen35"],
	[/qwen-?3-vl/, "qwen3-vl"],
	[/qwen-?3-coder|qwen3-235b-a22b-thinking-2507/, "qwen3-coder"],
	[/qwen-?2\.5/, "qwen25"],
	[/qwen-?3/, "qwen3"],
	[/qwen-(max|plus|turbo|flash)/, none(ALIAS)],
	[/mimo-v2\.5-pro/, "mimo25pro"],
	[/mimo-v2\.5/, "mimo25"],
	[/mimo-v2\.6/, "mimo26"],
	[/glm-4\.7-flash/, "glm5"],
	[/glm-?5|glm-5p|zai-glm-5/, "glm5"],
	[/glm-?4/, "glm45"],
	[/glm-(fast-|flash-)?latest/, none(ALIAS)],
	[/deepseek-v4[.p-]1/, "ds-v41flash"],
	[/deepseek-v4/, "ds-v4"],
	[/deepseek-(flash|pro)(-latest)?$|deepseek-chat$/, none(ALIAS)],
	[/deepseek-v3\.2-exp|deepseek(-chat)?-v3\.1/, "ds-v31"],
	[/deepseek(-|\.)v3\.2/, "ds-v32"],
	[/deepseek-r1/, "ds-r1"],
	[/deepseek(-chat)?-v3|deepseek\.v3/, "ds-v3"],
	[/kimi|moonshot|(^|\/)k3/, "kimi"],
	[/mistral-large-4/, out("Mistral Large 4's license (other, no terms to pin)")],
	[/large-3|large-2512/, "mistral-large3"],
	[/ministral|devstral-2|devstral-small-2|labs-devstral|devstral-latest|devstral-medium/, "mistral3"],
	[/mistral-large|pixtral-large/, none("no file (Mistral Large 2)")],
	[/nemo(?!tron)|pixtral-12b/, "mistral-nemo"],
	[/mixtral/, "mixtral"],
	[/small-3\.2|small-2506|magistral-small-2509/, none(TEKKEN)],
	[/small-3\.1/, "mistral-small31"],
	[/mistral|codestral|magistral|pixtral|voxtral|devstral|leanstral/, none(TEKKEN)],
	[/llama/, gated("Llama")],
	[/muse/, none("no public tokenizer (Muse)")],
	[/nemotron-3\.5-super-vl/, "nemotron35vl"],
	[/nemotron-3-nano|nemotron-nano-3/, "nemotron3nano"],
	[/nemotron-3|nemotron-super-3/, "nemotron3"],
	[/nemotron|cosmos/, out("Nemotron Nano v2 and Cosmos (the owner's decision)")],
	[/inkling-2-small/, "inkling2-small"],
	[/inkling/, "inkling"],
	[/ling-3/, "ling3"],
	[/ling-2|ring-2/, "ling26"],
];

/**
 * Names placed on an entry that count exactly for the budget only:
 * - GPT-5.1 and later: js-tiktoken maps only gpt-5, -mini, -nano, their dated ids and gpt-5-chat-latest to o200k,
 *   and no provider source maps the later generations;
 * - Ling 3.2, which has no public repo;
 * - `-latest` aliases that name a family and can move to a new file without the id changing;
 * - closed or API-only names placed by their generation.
 */
const ASSUMED =
	/gpt-5\.[1-9]|ling-3\.2|(kimi|devstral|ministral-[38]b|deepseek-v4-flash)-latest|qwen3-max|qwen3\.\d-(plus|max|flash|omni)|qwen-?3[.p]8-(max|flash|omni|2[.p]4t)|qwen3-coder-(plus|flash)|qwen3-vl-instruct|glm-5-turbo|glm-5v-turbo|glm-.*-(prime|highspeed|fast|flashx|legal)|mistral-(medium|small$|small-latest|small-2603|saba)|codestral|magistral-medium|devstral-medium|voxtral|leanstral|kimi-for-coding|kimi-fast|mimo-v2\.6-(flash|pro$|pro-ultra)|deepseek-v4-flash-vision/;

/** The tokenizer that counts this model, by its catalogue id. */
export function classifyModel(id: string): TokenizerClass {
	const s = id.toLowerCase();
	for (const [pattern, target] of RULES) {
		if (!pattern.test(s)) continue;
		if (typeof target !== "string") return { ...target };
		return { status: ASSUMED.test(s) ? "assumed" : "exact", entry: target };
	}
	return { status: "none", reason: "no rule" };
}
