/**
 * Session mixes: a deterministic plan of tasks (user prompts) and assistant turns. A turn is one planned
 * assistant response; all but the last turn of a task call a tool whose result is generated content.
 * Tool results are 1,000 to 50,000 characters (log-uniform: median about 7k, mean about 12.5k).
 */
import { type ContentClass, generate, hashSeed, rng } from "./content.ts";
import { loadCorpus } from "./corpus.ts";

export type MixName = "coding" | "research" | "cjk" | "data";
export const MIXES: MixName[] = ["coding", "research", "cjk", "data"];

/** Content class weights per mix. "write" is an assistant write_file call carrying code (result is short). */
export const MIX_WEIGHTS: Record<MixName, Array<[ContentClass | "write", number]>> = {
	coding: [
		["code", 0.38],
		["log", 0.18],
		["json", 0.12],
		["json-min", 0.05],
		["table", 0.08],
		["whitespace", 0.05],
		["prose", 0.05],
		["write", 0.09],
	],
	research: [
		["prose", 0.4],
		["markup", 0.3],
		["table", 0.15],
		["json", 0.05],
		["code", 0.05],
		["log", 0.05],
	],
	cjk: [
		["zh", 0.4],
		["ja", 0.3],
		["code", 0.1],
		["log", 0.08],
		["prose", 0.07],
		["json", 0.05],
	],
	data: [
		["base64", 0.25],
		["json-min", 0.25],
		["image", 0.2],
		["json", 0.12],
		["whitespace", 0.08],
		["log", 0.05],
		["table", 0.05],
	],
};

export interface ToolTurn {
	kind: "tool";
	id: string;
	text: string;
	tool: string;
	args: Record<string, unknown>;
	content: ContentClass | "write";
	size: number;
	seed: number;
}

export interface FinalTurn {
	kind: "final";
	text: string;
}

export type Turn = ToolTurn | FinalTurn;

export interface Task {
	prompt: string;
	turns: Turn[];
}

export interface SessionPlan {
	mix: MixName;
	seed: number;
	tasks: Task[];
	turns: number;
	classCounts: Record<string, number>;
	resultChars: number;
}

type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: R, items: readonly T[]): T => items[Math.floor(r() * items.length)];

function weighted<T>(r: R, items: Array<[T, number]>): T {
	const total = items.reduce((s, [, w]) => s + w, 0);
	let x = r() * total;
	for (const [item, w] of items) {
		x -= w;
		if (x <= 0) return item;
	}
	return items[items.length - 1][0];
}

/** Log-uniform tool-result size in [1,000, 50,000] characters. */
export function resultSize(r: R): number {
	return Math.round(1_000 * 50 ** r());
}

function toolFor(r: R, kind: ContentClass | "write", n: number): { tool: string; args: Record<string, unknown> } {
	const corpus = loadCorpus();
	const file = pick(r, corpus.code).path;
	switch (kind) {
		case "code":
			return { tool: "read_file", args: { path: file, ...(r() < 0.3 ? { offset: int(r, 1, 400) } : {}) } };
		case "write":
			return { tool: "write_file", args: { path: file.replace(/(\.\w+)$/, `.v${n}$1`), content: "" } };
		case "json":
			return r() < 0.5
				? { tool: "read_file", args: { path: pick(r, corpus.json).path } }
				: {
						tool: "web_fetch",
						args: { url: `https://api.github.com/search/issues?q=repo:earendil-works/pi+${n}&per_page=12` },
					};
		case "json-min":
			return {
				tool: "web_fetch",
				args: { url: `https://api.example.com/v2/records?page=${n}&format=json`, raw: true },
			};
		case "log":
			return {
				tool: "run_command",
				args: {
					command: pick(r, [
						"npm test 2>&1 | tail -n 2000",
						"journalctl -u api --since -2h",
						"docker logs --tail 3000 web",
						"kubectl logs deploy/worker --tail=2000",
					]),
				},
			};
		case "table":
			return {
				tool: "run_command",
				args: {
					command: pick(r, [
						"ls -lR packages",
						"ls -la packages/ai/src",
						"ps aux",
						"ls -lh packages/coding-agent",
					]),
				},
			};
		case "whitespace":
			return {
				tool: "run_command",
				args: {
					command: pick(r, [
						"kubectl get pods -A -o wide",
						"tree -a packages",
						"cat build/report.xml",
						"column -t report.txt",
					]),
				},
			};
		case "prose":
		case "markup":
			return { tool: "web_fetch", args: { url: `https://pi.dev/docs/${kind}/${n}` } };
		case "zh":
			return { tool: "web_fetch", args: { url: `https://docs.example.cn/zh-CN/guide/${n}` } };
		case "ja":
			return { tool: "web_fetch", args: { url: `https://docs.example.jp/ja/guide/${n}` } };
		case "base64":
			return { tool: "read_file", args: { path: `assets/blob-${n}.bin`, encoding: "base64" } };
		case "image":
			return { tool: "take_screenshot", args: { url: `http://localhost:5173/page/${n}`, fullPage: r() < 0.3 } };
	}
}

const EN_TOOL_TEXT = [
	"Let me look at that.",
	"I'll check the relevant file first.",
	"Next I need the output of the command to see what failed.",
	"That narrows it down. Reading the implementation now.",
	"I want to confirm how the data is shaped before changing anything.",
	"The error points somewhere else; following the stack trace.",
	"Good, that part works. Moving on to the next piece.",
];
const ZH_TOOL_TEXT = [
	"我先看一下相关的文件。",
	"接下来需要查看命令的输出，确认失败的原因。",
	"这部分没有问题，继续检查下一个模块。",
];
const JA_TOOL_TEXT = [
	"まず関連するファイルを確認します。",
	"次にコマンドの出力を見て、失敗の原因を確認します。",
	"この部分は問題ありません。次のモジュールを確認します。",
];

function assistantText(r: R, mix: MixName, final: boolean, taskNo: number): string {
	const corpus = loadCorpus();
	const lang = mix === "cjk" ? pick(r, ["en", "zh", "ja"] as const) : "en";
	if (!final) {
		const base =
			lang === "zh" ? pick(r, ZH_TOOL_TEXT) : lang === "ja" ? pick(r, JA_TOOL_TEXT) : pick(r, EN_TOOL_TEXT);
		return r() < 0.3 ? `${base} ${pick(r, corpus.paragraphs).slice(0, int(r, 80, 400))}` : base;
	}
	const long = r() < 0.15;
	const body = Array.from({ length: long ? int(r, 4, 10) : int(r, 1, 3) }, () => pick(r, corpus.paragraphs)).join(
		"\n\n",
	);
	return `Task ${taskNo} is done. ${body}`;
}

function userPrompt(r: R, mix: MixName, taskNo: number): string {
	const corpus = loadCorpus();
	const roll = r();
	if (taskNo > 0 && roll < 0.07)
		return pick(r, ["continue", "now run the tests too", "ok, ship it", "also fix the lint errors"]);
	const ask =
		mix === "cjk" && r() < 0.6
			? pick(r, [
					"请检查这个模块并修复失败的测试。",
					"このモジュールを調べて、失敗しているテストを直してください。",
					"请阅读文档并总结主要的变化。",
				])
			: pick(r, corpus.paragraphs).slice(0, int(r, 80, 600));
	if (roll > 0.9) {
		const pasted = generate("log", int(r, 1_500, 5_000), hashSeed("prompt", taskNo)).text;
		return `${ask}\n\nHere is the output I got:\n\n${pasted}`;
	}
	return `Task ${taskNo}: ${ask}`;
}

export function planSession(mix: MixName, seed: number, turns = 500): SessionPlan {
	const r = rng(hashSeed("plan", mix, seed));
	const tasks: Task[] = [];
	const classCounts: Record<string, number> = {};
	let planned = 0;
	let resultChars = 0;
	while (planned < turns) {
		const taskNo = tasks.length;
		const length = Math.min(int(r, 4, 30), turns - planned);
		const task: Task = { prompt: userPrompt(r, mix, taskNo), turns: [] };
		for (let t = 0; t < length; t++) {
			const n = planned + t;
			if (t === length - 1) {
				task.turns.push({ kind: "final", text: assistantText(r, mix, true, taskNo) });
				continue;
			}
			const content = weighted(r, MIX_WEIGHTS[mix]);
			const { tool, args } = toolFor(r, content, n);
			const size = content === "write" ? int(r, 1_000, 8_000) : resultSize(r);
			const turnSeed = hashSeed(seed, mix, n);
			if (content === "write") args.content = generate("code", size, turnSeed).text;
			else resultChars += size;
			classCounts[content] = (classCounts[content] ?? 0) + 1;
			task.turns.push({
				kind: "tool",
				id: `call_${n}_${turnSeed.toString(36)}`,
				text: assistantText(r, mix, false, taskNo),
				tool,
				args,
				content,
				size,
				seed: turnSeed,
			});
		}
		planned += length;
		tasks.push(task);
	}
	return { mix, seed, tasks, turns: planned, classCounts, resultChars };
}

/** The tool result for a planned turn. */
export function toolResult(turn: ToolTurn): {
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
} {
	if (turn.content === "write") {
		const content = String(turn.args.content ?? "");
		return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${String(turn.args.path)}.` };
	}
	const generated = generate(turn.content, turn.size, turn.seed);
	return { text: generated.text, images: generated.images };
}
