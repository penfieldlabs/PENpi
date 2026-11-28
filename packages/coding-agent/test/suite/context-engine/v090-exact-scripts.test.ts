/**
 * 0.9.0, commit 4 (design section 9): sessions in every prose script on every bundled tokenizer (o200k and cl100k),
 * on the exact path. The provider counts with the model's own tokenizer plus a few template tokens per message. In
 * each script the engine must detect no truncation, send nothing the provider rejects, and fill the window about as
 * full as in English: with exact counts, a script the estimate prices far off (CJK, Thai, Devanagari) is planned to
 * the same budget. And Russian to code and back, where the estimate's density changes and the counts don't.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { verifiedRequire } from "../context-engine-e2/tokenizer-cache.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import { endSession, finalTurn, installProviderSim, rng, scriptedModel, toolTurn } from "./helpers.ts";

const require = verifiedRequire();
const { Tiktoken } = require("js-tiktoken/lite") as {
	Tiktoken: new (ranks: unknown) => { encode(text: string, allowed: "all"): number[] };
};
const load = (name: string) => {
	const ranks = require(`js-tiktoken/ranks/${name}`) as { default?: unknown };
	const encoder = new Tiktoken(ranks.default ?? ranks);
	return (text: string) => encoder.encode(text, "all").length;
};
const TOKENIZERS = { o200k: load("o200k_base"), cl100k: load("cl100k_base") };
const MODELS = { o200k: "gpt-4o-scripts", cl100k: "gpt-4-scripts" };

/** Common words per script; scripts written without spaces are joined without them. */
const SCRIPTS: Record<string, { words: string[]; spaced: boolean; stop: string }> = {
	english: {
		words: "the of and to in is that it for was on with as they at by this from have not".split(" "),
		spaced: true,
		stop: ".",
	},
	russian: {
		words: "и в не на я что тот быть с а весь это как она по но они к у мы для из время человек работа".split(" "),
		spaced: true,
		stop: ".",
	},
	greek: {
		words: "και το να της η ο σε που με για είναι δεν ένα από τα στο θα μας".split(" "),
		spaced: true,
		stop: ".",
	},
	arabic: { words: "في من على أن إلى هذا التي الذي مع كان عن ما هذه بين عند كل".split(" "), spaced: true, stop: "." },
	hebrew: { words: "של את על זה לא הוא עם היא אני גם כל יש מה אבל רק אם".split(" "), spaced: true, stop: "." },
	hindi: { words: "के है में की और से को यह एक पर भी था कि लिए हैं नहीं".split(" "), spaced: true, stop: "।" },
	thai: { words: "ที่ และ การ ใน ของ เป็น ได้ มี ไม่ ให้ จะ ว่า คน นี้ กับ".split(" "), spaced: false, stop: " " },
	chinese: {
		words: "的 一 是 不 了 人 我 在 有 他 这 中 大 来 上 国 个 到 说 们 时间 工作".split(" "),
		spaced: false,
		stop: "。",
	},
	japanese: {
		words: "の に は を た が で て と し ある いる こと する 日本 時間 仕事 今日".split(" "),
		spaced: false,
		stop: "。",
	},
	korean: {
		words: "그리고 이 있다 하다 그 것 수 나 없다 사람 우리 아니다 보다 같다 시간 일".split(" "),
		spaced: true,
		stop: ".",
	},
};

/** Code, for Russian to code and back. */
const CODE = [
	"export function plan(items: Item[], budget: number): number {",
	"\tlet total = 0;",
	"\tfor (const item of items) {",
	"\t\tif (total + item.tokens > budget) break;",
	"\t\ttotal += item.tokens;",
	"\t}",
	"\treturn total;",
	"}",
];

function prose(script: string, tokens: number, count: (text: string) => number, seed: number): string {
	const { words, spaced, stop } = SCRIPTS[script];
	const next = rng(seed);
	let text = "";
	let n = 0;
	while (n < tokens) {
		const length = 8 + Math.floor(next() * 8);
		const sentence = Array.from({ length }, () => words[Math.floor(next() * words.length)]).join(spaced ? " " : "");
		const line = `${sentence}${stop}${next() < 0.2 ? "\n" : spaced ? " " : ""}`;
		text += line;
		n += count(line);
	}
	return text;
}

function code(tokens: number, count: (text: string) => number): string {
	let text = "";
	let n = 0;
	for (let i = 0; n < tokens; i++) {
		const line = `${CODE[i % CODE.length].replace("plan", `plan${i}`)}\n`;
		text += line;
		n += count(line);
	}
	return text;
}

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await endSession(harnesses.pop()!);
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const WINDOW = 32_000;
const TEMPLATE = 3;

async function until(condition: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A session whose tool outputs are `content(seed)`, sized in the provider's tokens; returns what it measured. */
async function run(tokenizer: keyof typeof TOKENIZERS, content: (turn: number, size: number) => string) {
	const count = TOKENIZERS[tokenizer];
	const stats = newStats();
	const reports: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "penpi-tokenizers-"));
	dirs.push(dir);
	const tool = (pi: ExtensionAPI) =>
		pi.registerTool({
			name: "work",
			label: "work",
			description: "Return text of a given size.",
			parameters: Type.Object({ size: Type.Number(), seed: Type.Number() }),
			execute: async (_id, { size, seed }) => ({
				content: [{ type: "text", text: content(seed, size) }],
				details: {},
			}),
		});
	const harness = await createHarness({
		models: [{ id: MODELS[tokenizer], contextWindow: WINDOW, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			tool,
			createContextEngine({ stats, env: {}, tokenizerCacheDir: dir, report: (json: string) => reports.push(json) }),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const sim = installProviderSim(harness, {
		countTokens: (parts) => parts.reduce((sum, p) => sum + count(p) + TEMPLATE, 0),
		realLimit: WINDOW,
	});
	const model = scriptedModel(harness);
	model.push(finalTurn("ready"));
	await harness.session.prompt("Start.");
	await until(() => reports.some((r) => r.includes('"path":"exact"')));
	let seed = 1;
	for (let p = 0; p < 10; p++) {
		for (let t = 0; t < 3; t++) model.push(toolTurn(2_000, seed++));
		model.push(finalTurn(`done ${p}`));
		await harness.session.prompt(`Task ${p}`);
	}
	const exact = stats.sent.map((s, i) => ({ s, c: sim.calls[i] })).filter((x) => x.s.exact !== undefined);
	return {
		stats,
		rejected: sim.calls.filter((c) => c.rejected).length,
		// How full the engine keeps the window: the largest request, against the window.
		used: Math.max(...exact.map((x) => x.c.promptTokens)) / WINDOW,
		cuts: stats.cuts.length,
	};
}

describe("0.9.0: prose scripts on every bundled tokenizer, on the exact path", () => {
	for (const tokenizer of Object.keys(TOKENIZERS) as Array<keyof typeof TOKENIZERS>) {
		it(`every script on ${tokenizer}: no truncation, no overflow, and the window used as in English`, async () => {
			const used: Record<string, number> = {};
			for (const script of Object.keys(SCRIPTS)) {
				const result = await run(tokenizer, (seed, size) => prose(script, size, TOKENIZERS[tokenizer], seed));
				expect(result.stats.plateaus, script).toEqual([]);
				expect(result.rejected, script).toBe(0);
				expect(result.cuts, script).toBeGreaterThan(0);
				used[script] = result.used;
			}
			// Set from the first run: every script within 0.05 of English's share of the window.
			for (const [script, share] of Object.entries(used))
				expect(Math.abs(share - used.english), `${script}: ${JSON.stringify(used)}`).toBeLessThan(0.05);
		}, 600_000);
	}

	it("Russian to code and back on o200k: no truncation, no overflow", async () => {
		const count = TOKENIZERS.o200k;
		const result = await run("o200k", (seed, size) =>
			seed % 9 < 3 || seed % 9 > 5 ? prose("russian", size, count, seed) : code(size, count),
		);
		expect(result.stats.plateaus).toEqual([]);
		expect(result.rejected).toBe(0);
		expect(result.cuts).toBeGreaterThan(0);
	}, 600_000);
});
