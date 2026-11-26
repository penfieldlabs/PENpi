import { describe, expect, it } from "vitest";
import {
	DEFAULT_TOKENS_PER_MS,
	describeEntry,
	KIMI_BASE_TOKENS,
	KIMI_PATTERN,
	kimiSpecials,
	TOKENS_PER_MS,
} from "./describe.ts";
import { TOKENIZERS } from "./table.ts";

/**
 * Kimi's pattern as tokenization_kimi.py writes it, in JavaScript's `v` mode, which has class intersection: only the
 * case-insensitive contractions differ, and the second test pins those.
 */
const CONTRACTION = "(?:'[sSſ]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])";
const ORIGINAL = new RegExp(
	[
		"[\\p{sc=Han}]+",
		`[^\\r\\n\\p{L}\\p{N}]?[[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]&&[^\\p{sc=Han}]]*[[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]&&[^\\p{sc=Han}]]+${CONTRACTION}?`,
		`[^\\r\\n\\p{L}\\p{N}]?[[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]&&[^\\p{sc=Han}]]+[[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]&&[^\\p{sc=Han}]]*${CONTRACTION}?`,
		"\\p{N}{1,3}",
		" ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*",
		"\\s*[\\r\\n]+",
		"\\s+(?!\\S)",
		"\\s+",
	].join("|"),
	"gv",
);

function pieces(pattern: RegExp, text: string): string[] {
	return [...text.matchAll(pattern)].map((m) => m[0]);
}

describe("Kimi's split pattern, written for JavaScript", () => {
	it("splits as the original does, on mixed scripts, marks, digits, punctuation and spaces", () => {
		const translated = new RegExp(KIMI_PATTERN, "gu");
		const fixed = [
			"Don't stop: it's THEY'RE and we'LL've I'd",
			"中文字符和English混合，漢字かなカタカナ한국어",
			"café naïve é Ἀθῆναι Москва ＡＢＣ",
			"1234567 12.5 v1.0.21\n\n\t  x  \r\n",
			"<|im_end|> [EOS] ===== ---- // ** ```ts\nconst a = 1;```",
			"ſ'ſ Kelvin 'K K's",
		];
		let seed = 7;
		const pool = [..."aZé漢かカ한Ж1 .,'\n\t́-_/ſ"];
		for (let n = 0; n < 300; n++) {
			let text = "";
			for (let i = 0; i < 60; i++) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				text += pool[seed % pool.length];
			}
			fixed.push(text);
		}
		for (const text of fixed) expect(pieces(translated, text), JSON.stringify(text)).toEqual(pieces(ORIGINAL, text));
	});

	it("the contractions match what (?i:...) matches under Unicode case folding", () => {
		const folded = /^(?:'s|'t|'re|'ve|'m|'ll|'d)$/iu;
		const spelled = new RegExp(`^${CONTRACTION}$`, "u");
		const chars = [..."sStTrReEvVmMlLdDſKkıİxX"];
		for (const a of chars) {
			expect(spelled.test(`'${a}`), a).toBe(folded.test(`'${a}`));
			for (const b of chars) expect(spelled.test(`'${a}${b}`), a + b).toBe(folded.test(`'${a}${b}`));
		}
		expect(KIMI_PATTERN).toContain(CONTRACTION);
	});

	it("names Kimi's 256 specials from its first id, the named ones from tokenizer_config.json", () => {
		const specials = kimiSpecials();
		expect(Object.keys(specials)).toHaveLength(256);
		expect(specials["[BOS]"]).toBe(KIMI_BASE_TOKENS);
		expect(specials["<|im_end|>"]).toBe(163_586);
		expect(specials["<|reserved_token_163589|>"]).toBe(163_589);
		expect(specials["[PAD]"]).toBe(163_839);
	});
});

describe("prior counting rates", () => {
	it("pins each measured family's rate, and the rest take the slowest", () => {
		expect(TOKENS_PER_MS).toEqual({
			o200k: 100,
			glm5: 190,
			glm45: 190,
			gemma4: 25,
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
		});
		for (const id of Object.keys(TOKENS_PER_MS))
			expect(
				TOKENIZERS.some((e) => e.id === id),
				id,
			).toBe(true);
		const unmeasured = TOKENIZERS.find((e) => !(e.id in TOKENS_PER_MS))!;
		expect(describeEntry(unmeasured).charsPerMs).toBe(DEFAULT_TOKENS_PER_MS * 4);
	});
});
