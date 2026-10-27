/**
 * Deterministic content generator. generate(kind, size, seed) depends only on its arguments and the
 * corpus (real files of this checkout), never on Math.random or the clock.
 *
 * Classes: English prose, markup (Markdown and HTML), source code from the repo in several indentation
 * styles, indented and minified JSON, log lines, `ls -l`-style tables, Chinese, Japanese, base64 blobs,
 * whitespace-heavy terminal output, and images (real PNGs from the repo).
 */
import { type Corpus, loadCorpus, type SourceFile } from "./corpus.ts";

export type ContentClass =
	| "prose"
	| "markup"
	| "code"
	| "json"
	| "json-min"
	| "log"
	| "table"
	| "zh"
	| "ja"
	| "base64"
	| "whitespace"
	| "image";

export const CONTENT_CLASSES: ContentClass[] = [
	"prose",
	"markup",
	"code",
	"json",
	"json-min",
	"log",
	"table",
	"zh",
	"ja",
	"base64",
	"whitespace",
	"image",
];

export interface Generated {
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** What was used (file paths, variant), for the report. */
	source: string;
}

/** mulberry32. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hashSeed(...parts: Array<string | number>): number {
	let h = 2166136261;
	for (const ch of parts.join("|")) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: R, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const pad = (s: string | number, n: number) => String(s).padStart(n);
const padEnd = (s: string | number, n: number) => String(s).padEnd(n);

/** Cut at `size`, preferring a line end in the last 15%. */
function clip(text: string, size: number): string {
	if (text.length <= size) return text;
	const nl = text.lastIndexOf("\n", size);
	let cut = nl >= size * 0.85 ? nl : size;
	const code = text.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return text.slice(0, cut);
}

function fill(size: number, next: () => string, joiner = "\n"): string {
	const parts: string[] = [];
	let length = 0;
	let guard = 0;
	while (length < size && guard++ < 100_000) {
		const part = next();
		parts.push(part);
		length += part.length + joiner.length;
	}
	return clip(parts.join(joiner), size);
}

// ----------------------------------------------------------------------------------- prose, markup

function prose(c: Corpus, r: R, size: number): Generated {
	let i = Math.floor(r() * c.paragraphs.length);
	const text = fill(
		size,
		() => {
			if (r() < 0.15) i = Math.floor(r() * c.paragraphs.length);
			return c.paragraphs[i++ % c.paragraphs.length];
		},
		"\n\n",
	);
	return { text, source: "repo Markdown prose" };
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

function htmlPage(c: Corpus, r: R, size: number): string {
	let i = Math.floor(r() * c.paragraphs.length);
	const head =
		'<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
		`  <title>${c.paragraphs[i].split(" ").slice(0, 6).join(" ")}</title>\n  <link rel="stylesheet" href="/assets/main.4f2a91c3.css">\n  <script defer src="/assets/app.7b1e0d22.js"></script>\n</head>\n<body class="docs">\n<nav class="sidebar"><ul>\n` +
		Array.from({ length: 8 }, () => {
			const words = pick(r, c.paragraphs).split(" ").slice(0, 3).join(" ");
			return `    <li class="nav-item"><a href="/docs/${slug(words)}" data-track="nav">${words}</a></li>`;
		}).join("\n") +
		'\n</ul></nav>\n<main id="content">\n<article>\n';
	const body = fill(Math.max(0, size - head.length), () => {
		const p = c.paragraphs[i++ % c.paragraphs.length];
		const roll = r();
		if (roll < 0.15) return `<h2 id="${slug(p)}">${p.split(" ").slice(0, 5).join(" ")}</h2>`;
		if (roll < 0.3) {
			const items = p
				.split(/(?<=\.) /)
				.slice(0, 4)
				.map((s) => `  <li><a href="https://pi.dev/docs/${slug(s)}" rel="noopener">${s}</a></li>`);
			return `<ul class="list">\n${items.join("\n")}\n</ul>`;
		}
		if (roll < 0.4) {
			const file = pick(r, c.code);
			const lines = file.text
				.split("\n")
				.slice(0, int(r, 4, 14))
				.join("\n");
			return `<pre><code class="language-${file.lang}">${lines.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`;
		}
		return `<p class="${pick(r, ["lead", "body", "note", "body"])}">${p}</p>`;
	});
	return `${head}${body}`;
}

function markup(c: Corpus, r: R, size: number): Generated {
	if (r() < 0.5) {
		let i = Math.floor(r() * c.sections.length);
		return { text: fill(size, () => c.sections[i++ % c.sections.length], "\n\n"), source: "repo Markdown sections" };
	}
	if (c.html.length > 0 && r() < 0.25) {
		const page = pick(r, c.html);
		return { text: clip(page.repeat(Math.ceil(size / page.length)), size), source: "repo HTML template" };
	}
	return { text: htmlPage(c, r, size), source: "HTML page from repo prose" };
}

// ----------------------------------------------------------------------------------- code

function reindent(text: string, style: "tabs" | "2" | "4"): string {
	if (style === "tabs") return text;
	const unit = style === "2" ? "  " : "    ";
	return text.replace(/^\t+/gm, (tabs) => unit.repeat(tabs.length));
}

function codeFile(c: Corpus, r: R): SourceFile {
	const roll = r();
	const langs =
		roll < 0.6
			? ["typescript"]
			: roll < 0.75
				? ["rust"]
				: roll < 0.85
					? ["yaml", "shell", "toml"]
					: ["c", "css", "html", "javascript"];
	const pool = c.code.filter((f) => langs.includes(f.lang));
	return pick(r, pool.length > 0 ? pool : c.code);
}

function code(c: Corpus, r: R, size: number): Generated {
	const style = pick(r, ["tabs", "tabs", "2", "4"] as const);
	const numbered = r() < 0.25;
	const used: string[] = [];
	let first = true;
	let lineNo = 0;
	const text = fill(size, () => {
		const file = codeFile(c, r);
		used.push(`${file.path}`);
		const lines = reindent(file.text, style).split("\n");
		const start = first && lines.length > 40 ? Math.floor(r() * lines.length * 0.6) : 0;
		const header = first ? "" : `\n==> ${file.path} <==\n`;
		first = false;
		lineNo = start;
		const body = lines.slice(start).map((line) => (numbered ? `${pad(++lineNo, 6)}\t${line}` : line));
		return header + body.join("\n");
	});
	return {
		text,
		source: `code (${style === "tabs" ? "original indentation" : `tabs->${style} spaces`}${numbered ? ", cat -n" : ""}): ${used.slice(0, 3).join(", ")}`,
	};
}

// ----------------------------------------------------------------------------------- JSON

const LOGINS = [
	"mariozechner",
	"octocat",
	"jdoe",
	"a-kim",
	"lucia.dev",
	"bot-ci",
	"sam_ops",
	"nguyen-t",
	"elif",
	"rkumar",
];
const LABELS = ["bug", "enhancement", "docs", "triage", "good first issue", "performance", "regression", "question"];

function iso(r: R): string {
	const t = Date.UTC(2025, 0, 1) + Math.floor(r() * 640 * 86_400_000);
	return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hex(r: R, n: number): string {
	let s = "";
	for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)];
	return s;
}

function apiRecord(c: Corpus, r: R, n: number): Record<string, unknown> {
	const sentence = pick(r, c.paragraphs);
	const login = pick(r, LOGINS);
	const number = 1000 + n;
	return {
		id: 2_000_000_000 + Math.floor(r() * 99_999_999),
		node_id: `I_kwDO${hex(r, 12)}`,
		number,
		title: sentence
			.split(" ")
			.slice(0, int(r, 5, 11))
			.join(" "),
		state: r() < 0.7 ? "open" : "closed",
		locked: false,
		user: {
			login,
			id: 100_000 + Math.floor(r() * 9_000_000),
			avatar_url: `https://avatars.githubusercontent.com/u/${int(r, 1000, 9999999)}?v=4`,
			type: login.startsWith("bot") ? "Bot" : "User",
			site_admin: false,
		},
		labels: Array.from({ length: int(r, 0, 3) }, () => {
			const name = pick(r, LABELS);
			return { id: int(r, 1e8, 9e8), name, color: hex(r, 6), default: name === "bug" };
		}),
		comments: int(r, 0, 40),
		created_at: iso(r),
		updated_at: iso(r),
		closed_at: r() < 0.3 ? iso(r) : null,
		author_association: pick(r, ["OWNER", "MEMBER", "CONTRIBUTOR", "NONE"]),
		url: `https://api.github.com/repos/earendil-works/pi/issues/${number}`,
		html_url: `https://github.com/earendil-works/pi/issues/${number}`,
		body: sentence,
		reactions: { total_count: int(r, 0, 12), "+1": int(r, 0, 9), heart: int(r, 0, 3) },
		score: Math.round(r() * 1e4) / 1e2,
	};
}

function jsonValue(c: Corpus, r: R): { value: unknown; source: string } {
	if (r() < 0.5 && c.json.length > 0) {
		const file = pick(r, c.json);
		return { value: file.value, source: file.path };
	}
	return {
		value: {
			total_count: int(r, 50, 5000),
			incomplete_results: false,
			items: Array.from({ length: 12 }, (_, i) => apiRecord(c, r, i)),
		},
		source: "GitHub-style API listing",
	};
}

function json(c: Corpus, r: R, size: number, minified: boolean): Generated {
	const sources: string[] = [];
	const indent = minified ? 0 : pick(r, [2, 2, 4]);
	const text = fill(size, () => {
		const { value, source } = jsonValue(c, r);
		sources.push(source);
		return JSON.stringify(value, null, indent || undefined);
	});
	return { text, source: `${minified ? "minified" : `indented(${indent})`} JSON: ${sources.slice(0, 3).join(", ")}` };
}

// ----------------------------------------------------------------------------------- logs

function ident(c: Corpus, r: R): string {
	const file = pick(r, c.code);
	const names = file.text.match(/(?:function|class|const|fn|def)\s+([A-Za-z_][A-Za-z0-9_]{3,})/g) ?? ["handler"];
	return pick(r, names).split(/\s+/).pop() ?? "handler";
}

function log(c: Corpus, r: R, size: number): Generated {
	const formats = [pick(r, [0, 1, 2, 3, 4]), pick(r, [0, 1, 2, 3, 4])];
	let t = Date.UTC(2026, 9, 12, int(r, 0, 23), int(r, 0, 59), int(r, 0, 59)) + int(r, 0, 999);
	const ip = () => `10.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}`;
	const lines = () => {
		t += int(r, 1, 1800);
		const at = new Date(t).toISOString();
		const path = pick(r, c.code).path;
		switch (pick(r, formats)) {
			case 0: {
				const level = pick(r, ["INFO ", "INFO ", "DEBUG", "WARN ", "ERROR"]);
				return `${at} ${level} [${pick(r, ["http", "db", "worker", "auth", "cache"])}] ${pick(r, ["GET", "POST", "PUT", "DELETE"])} /api/v1/${pick(r, ["sessions", "models", "users", "jobs"])}/${hex(r, 8)} ${pick(r, [200, 200, 201, 204, 400, 404, 429, 500])} ${(r() * 900).toFixed(1)}ms req_id=${hex(r, 16)} user=${pick(r, LOGINS)}`;
			}
			case 1: {
				const month = "Oct";
				const d = new Date(t);
				return `${ip()} - - [${d.getUTCDate()}/${month}/2026:${d.toISOString().slice(11, 19)} +0000] "${pick(r, ["GET", "POST"])} /${slug(pick(r, c.paragraphs).split(" ").slice(0, 3).join(" "))}?page=${int(r, 1, 40)} HTTP/1.1" ${pick(r, [200, 200, 304, 404, 502])} ${int(r, 120, 98_000)} "-" "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"`;
			}
			case 2: {
				if (r() < 0.25)
					return `Error: ${pick(r, c.paragraphs).split(" ").slice(0, 8).join(" ")}\n${Array.from(
						{ length: int(r, 3, 9) },
						() => `    at ${ident(c, r)} (${pick(r, c.code).path}:${int(r, 1, 900)}:${int(r, 1, 80)})`,
					).join("\n")}`;
				return ` ${pick(r, ["✓", "✓", "✓", "×", "↓"])} ${path} (${int(r, 1, 60)} tests${r() < 0.2 ? ` | ${int(r, 1, 4)} skipped` : ""}) ${int(r, 2, 4000)}ms`;
			}
			case 3: {
				const d = new Date(t);
				return `Oct ${pad(d.getUTCDate(), 2)} ${d.toISOString().slice(11, 19)} build-${int(r, 1, 9)} ${pick(r, ["systemd[1]", "kernel", "dockerd[812]", "sshd[2231]", "containerd[640]"])}: ${pick(r, ["Started", "Stopped", "Reloading", "Failed to start", "Mounted"])} ${slug(path).replace(/-/g, "_")}.service${r() < 0.3 ? ` (code=exited, status=${int(r, 0, 3)})` : ""}`;
			}
			default:
				return `[${at.slice(11, 23)}] ${pick(r, ["npm", "tsc", "vite", "esbuild"])} ${pick(r, ["info", "warn", "verb", "http"])} ${pick(r, ["fetch GET 200", "reify", "build", "compile", "resolve"])} ${path} ${int(r, 1, 900)}ms`;
		}
	};
	return { text: fill(size, lines), source: `logs (formats ${formats.join(",")})` };
}

// ----------------------------------------------------------------------------------- tables

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function lsTable(c: Corpus, r: R, size: number): string {
	let i = Math.floor(r() * c.listing.length);
	const owner = pick(r, ["dev", "root", "runner", "mz"]);
	const group = pick(r, ["staff", "root", "docker", "users"]);
	const human = r() < 0.3;
	const size_ = (n: number) =>
		human ? (n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : n > 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`) : `${n}`;
	let dir = "";
	const block = () => {
		const rows: string[] = [];
		const entries = c.listing.slice(i, i + int(r, 8, 40));
		i = (i + entries.length) % Math.max(1, c.listing.length - 40);
		const d = entries[0]?.path.split("/").slice(0, -1).join("/") ?? ".";
		if (d !== dir) {
			dir = d;
			rows.push(`\n${d || "."}:`);
		}
		rows.push(`total ${Math.round(entries.reduce((s, e) => s + e.size, 0) / 1024)}`);
		for (const e of entries) {
			const isDir = r() < 0.08;
			const mode = isDir ? "drwxr-xr-x" : pick(r, ["-rw-r--r--", "-rw-r--r--", "-rwxr-xr-x", "-rw-------"]);
			const m = pick(r, MONTHS);
			rows.push(
				`${mode} ${pad(isDir ? int(r, 2, 12) : 1, 2)} ${padEnd(owner, 6)} ${padEnd(group, 6)} ${pad(size_(isDir ? 4096 : e.size), human ? 6 : 8)} ${m} ${pad(int(r, 1, 28), 2)} ${r() < 0.5 ? `${pad(int(r, 0, 23), 2)}:${String(int(r, 0, 59)).padStart(2, "0")}` : " 2025"} ${e.path.split("/").pop()}`,
			);
		}
		return rows.join("\n");
	};
	return fill(size, block);
}

function otherTable(c: Corpus, r: R, size: number): string {
	if (r() < 0.5) {
		const header = "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND";
		return `${header}\n${fill(size - header.length, () => `${padEnd(pick(r, ["root", "dev", "www-data", "postgres"]), 10)} ${pad(int(r, 1, 99999), 6)} ${pad((r() * 40).toFixed(1), 4)} ${pad((r() * 12).toFixed(1), 4)} ${pad(int(r, 1e4, 9e6), 7)} ${pad(int(r, 1e3, 2e6), 6)} ${padEnd(pick(r, ["?", "pts/0", "pts/1"]), 8)} ${padEnd(pick(r, ["Ss", "S", "R+", "Sl", "I<"]), 4)} ${pad(`${pad(int(r, 0, 23), 2)}:${String(int(r, 0, 59)).padStart(2, "0")}`, 5)} ${pad(`${int(r, 0, 300)}:${String(int(r, 0, 59)).padStart(2, "0")}`, 6)} ${pick(r, ["node", "/usr/bin/python3", "postgres:", "nginx: worker", "/usr/lib/systemd/systemd"])} ${pick(r, c.code).path}`)}`;
	}
	const cols = ["Package", "Version", "Size", "Files", "License"];
	const head = `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|`;
	return `${head}\n${fill(size - head.length, () => {
		const f = pick(r, c.listing);
		return `| ${f.path.split("/").slice(0, 2).join("/")} | ${int(r, 0, 3)}.${int(r, 0, 40)}.${int(r, 0, 20)} | ${f.size} B | ${int(r, 1, 300)} | ${pick(r, ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause"])} |`;
	})}`;
}

function table(c: Corpus, r: R, size: number): Generated {
	return r() < 0.75
		? { text: lsTable(c, r, size), source: "ls -l of repo files" }
		: { text: otherTable(c, r, size), source: "ps aux / Markdown table" };
}

// ----------------------------------------------------------------------------------- CJK

const ZH = [
	"这个函数负责读取配置文件，并在启动时校验所有必填字段。",
	"如果上下文窗口已满，引擎会把最早的消息移出窗口，但完整的记录仍然保存在会话文件中。",
	"我们在测试中发现，中文文本的分词密度明显高于英文，每个汉字大约对应零点七个词元。",
	"请先运行单元测试，确认修改没有破坏现有的行为，然后再提交代码。",
	"日志显示请求在第三次重试后仍然失败，错误码为四百一十三。",
	"为了减少内存占用，缓存只保留最近使用的一千条记录。",
	"该接口返回的数据结构包括用户编号、创建时间和最后一次登录的地址。",
	"部署脚本会自动检测当前的操作系统版本，并下载对应的二进制文件。",
	"在高并发场景下，数据库连接池的大小需要根据实际负载进行调整。",
	"这段代码的时间复杂度是线性的，但在最坏情况下可能退化为平方级。",
	"用户反馈说，在网络不稳定的时候，界面会长时间停留在加载状态。",
	"我们决定把旧的同步接口标记为废弃，并在下一个主版本中移除。",
	"模型的输出被截断了，因为请求中设置的最大输出长度太小。",
	"配置项的默认值写在文档里，但实际代码中的值与文档并不一致。",
	"构建失败的原因是依赖包的版本冲突，需要锁定到兼容的版本。",
	"每次提交之前，格式化工具会自动整理缩进和空白字符。",
	"测试覆盖率报告显示，错误处理分支几乎没有被执行过。",
	"这个问题只在视窗系统上出现，因为路径分隔符的处理方式不同。",
	"新的分页逻辑把每页的条目数量从五十条提高到了两百条。",
	"当磁盘空间不足时，服务会拒绝写入新的会话记录并发出警告。",
	"我们需要一个更可靠的方法来估算请求的词元数量，而不是简单地按字符数除以四。",
	"迁移脚本会把旧格式的会话文件转换成新的结构，并保留原始的时间戳。",
	"在提示词中固定任务描述，可以帮助模型在长对话中保持方向。",
	"这个依赖已经很久没有维护了，建议替换成社区更活跃的实现。",
	"请求头中缺少认证信息，所以服务器返回了未授权的错误。",
	"性能分析表明，大部分时间花在了序列化和反序列化上。",
	"文件监视器在检测到变化后，会在两百毫秒内重新加载扩展。",
	"为了兼容旧版本的客户端，响应中仍然保留了已经废弃的字段。",
	"我们把超时时间从三十秒延长到了两分钟，以适应较慢的模型。",
	"下面是修改后的配置示例，请根据自己的环境替换其中的路径。",
	"春天的早晨，河边的柳树刚刚发芽，空气里有泥土和青草的味道。",
	"他在笔记本上记下了每一次实验的结果，包括失败的那些。",
];
const ZH_HEADINGS = ["## 概述", "## 问题描述", "### 复现步骤", "### 解决方案", "## 注意事项", "### 测试结果"];

const JA = [
	"この関数は設定ファイルを読み込み、起動時にすべての必須項目を検証します。",
	"コンテキストウィンドウがいっぱいになると、エンジンは最も古いメッセージを外しますが、完全な記録はセッションファイルに残ります。",
	"テストの結果、日本語のテキストは英語よりもトークン密度が高いことがわかりました。",
	"変更をコミットする前に、まずユニットテストを実行して既存の動作が壊れていないことを確認してください。",
	"ログによると、リクエストは三回目の再試行の後も失敗し、ステータスコードは四一三でした。",
	"メモリ使用量を減らすため、キャッシュには最近使われた千件のエントリだけを保持します。",
	"このエンドポイントは、ユーザーID、作成日時、最終ログインの場所を含むデータを返します。",
	"デプロイスクリプトは現在のOSのバージョンを自動的に検出し、対応するバイナリをダウンロードします。",
	"高負荷の環境では、データベース接続プールのサイズを実際の負荷に合わせて調整する必要があります。",
	"このコードの計算量は線形ですが、最悪の場合には二乗に悪化する可能性があります。",
	"ネットワークが不安定なとき、画面が長い間読み込み中のままになるという報告がありました。",
	"古い同期APIを非推奨とし、次のメジャーバージョンで削除することにしました。",
	"リクエストで指定した最大出力長が小さすぎたため、モデルの出力が途中で切れました。",
	"設定項目のデフォルト値はドキュメントに書かれていますが、実際のコードの値とは一致していません。",
	"ビルドが失敗した原因は依存パッケージのバージョン競合で、互換性のあるバージョンに固定する必要があります。",
	"コミットのたびに、フォーマッターがインデントと空白を自動的に整えます。",
	"カバレッジレポートを見ると、エラー処理の分岐はほとんど実行されていません。",
	"この問題はウィンドウズでのみ発生し、パス区切り文字の扱いが異なることが原因です。",
	"新しいページネーションでは、一ページあたりの件数を五十件から二百件に増やしました。",
	"ディスクの空き容量が不足すると、サービスは新しいセッション記録の書き込みを拒否し、警告を出します。",
	"文字数を四で割るだけではなく、より正確にトークン数を見積もる方法が必要です。",
	"移行スクリプトは古い形式のセッションファイルを新しい構造に変換し、元のタイムスタンプを保持します。",
	"プロンプトにタスクの説明を固定しておくと、長い会話でもモデルが方向を見失いにくくなります。",
	"この依存関係は長い間メンテナンスされていないので、より活発な実装に置き換えることをお勧めします。",
	"リクエストヘッダーに認証情報が含まれていなかったため、サーバーは未認証エラーを返しました。",
	"プロファイリングの結果、処理時間の大半はシリアライズとデシリアライズに費やされていました。",
	"ファイル監視は変更を検出してから二百ミリ秒以内に拡張機能を再読み込みします。",
	"古いクライアントとの互換性のため、レスポンスには非推奨のフィールドがまだ残っています。",
	"遅いモデルに対応するため、タイムアウトを三十秒から二分に延長しました。",
	"以下は修正後の設定例です。パスはご自分の環境に合わせて置き換えてください。",
	"秋の夕暮れ、駅前の商店街には焼き芋の香りが漂っていた。",
	"彼女は毎朝六時に起きて、コーヒーを飲みながら新聞を読む。",
];
const JA_HEADINGS = ["## 概要", "## 再現手順", "### 原因", "### 対応方針", "## 注意事項", "### テスト結果"];

function cjk(c: Corpus, r: R, size: number, lang: "zh" | "ja"): Generated {
	const sentences = lang === "zh" ? ZH : JA;
	const headings = lang === "zh" ? ZH_HEADINGS : JA_HEADINGS;
	const text = fill(
		size,
		() => {
			const roll = r();
			if (roll < 0.08) return `\n${pick(r, headings)}\n`;
			const n = int(r, 2, 7);
			let paragraph = "";
			for (let k = 0; k < n; k++) {
				let s = pick(r, sentences);
				if (r() < 0.2) s = s.replace(/[，、]/, `（\`${ident(c, r)}()\`）、`);
				if (r() < 0.1) s = `- ${s}`;
				paragraph += s;
			}
			return paragraph;
		},
		"\n",
	);
	return { text, source: lang === "zh" ? "Chinese technical text" : "Japanese technical text" };
}

// ----------------------------------------------------------------------------------- base64

function randomBytes(r: R, n: number): Buffer {
	const bytes = Buffer.alloc(n);
	for (let i = 0; i < n; i++) bytes[i] = Math.floor(r() * 256);
	return bytes;
}

function base64(c: Corpus, r: R, size: number): Generated {
	const variant = pick(r, ["line", "mime", "json", "pem"] as const);
	const real = r() < 0.5 && c.binaries.length > 0 ? pick(r, c.binaries) : undefined;
	const bytesNeeded = Math.ceil((size * 3) / 4) + 64;
	let bytes: Buffer;
	if (real) {
		const start = Math.floor(r() * Math.max(1, real.bytes.length - bytesNeeded));
		bytes = real.bytes.subarray(start, start + bytesNeeded);
		if (bytes.length < bytesNeeded) bytes = Buffer.concat([bytes, randomBytes(r, bytesNeeded - bytes.length)]);
	} else bytes = randomBytes(r, bytesNeeded);
	const b64 = bytes.toString("base64");
	const wrap = (s: string, w: number) => s.match(new RegExp(`.{1,${w}}`, "g"))?.join("\n") ?? s;
	let text: string;
	if (variant === "line") text = b64;
	else if (variant === "mime")
		text = `Content-Type: application/octet-stream\nContent-Transfer-Encoding: base64\n\n${wrap(b64, 76)}`;
	else if (variant === "json")
		text = `{"name":"${real?.path.split("/").pop() ?? "blob.bin"}","encoding":"base64","content":"${b64}"}`;
	else text = `-----BEGIN CERTIFICATE-----\n${wrap(b64, 64)}\n-----END CERTIFICATE-----`;
	return { text: clip(text, size), source: `base64 (${variant}) of ${real ? real.path : "random bytes"}` };
}

// ----------------------------------------------------------------------------------- whitespace

function whitespace(c: Corpus, r: R, size: number): Generated {
	const variant = pick(r, ["columns", "tree", "xml", "report"] as const);
	let text: string;
	if (variant === "columns") {
		const header = `${padEnd("NAME", 52)}${padEnd("READY", 10)}${padEnd("STATUS", 22)}${padEnd("RESTARTS", 12)}${padEnd("AGE", 8)}${padEnd("IP", 18)}NODE`;
		text = `${header}\n${fill(size, () => `${padEnd(`${slug(pick(r, c.code).path).slice(0, 30)}-${hex(r, 10)}-${hex(r, 5)}`, 52)}${padEnd(`${int(r, 0, 2)}/2`, 10)}${padEnd(pick(r, ["Running", "Running", "CrashLoopBackOff", "Pending", "Completed"]), 22)}${padEnd(int(r, 0, 40), 12)}${padEnd(`${int(r, 1, 90)}d`, 8)}${padEnd(`10.244.${int(r, 0, 9)}.${int(r, 2, 250)}`, 18)}node-${int(r, 1, 9)}    `)}`;
	} else if (variant === "tree") {
		let i = Math.floor(r() * c.listing.length);
		text = fill(size, () => {
			const parts = c.listing[i++ % c.listing.length].path.split("/");
			return parts
				.map((p, d) => `${"│       ".repeat(d)}${d === parts.length - 1 ? "└────── " : "├────── "}${p}`)
				.join("\n");
		});
	} else if (variant === "xml") {
		const toXml = (value: unknown, name: string, depth: number): string => {
			const ind = " ".repeat(depth * 8);
			if (value === null || typeof value !== "object") return `${ind}<${name}>${String(value)}</${name}>`;
			const entries = Array.isArray(value) ? value.map((v) => ["item", v] as const) : Object.entries(value);
			return `${ind}<${name}>\n${entries
				.slice(0, 40)
				.map(([k, v]) => toXml(v, String(k).replace(/[^A-Za-z0-9_]/g, "_") || "x", depth + 1))
				.join("\n")}\n${ind}</${name}>`;
		};
		text = fill(size, () => toXml(jsonValue(c, r).value, "document", 0));
	} else {
		text = fill(size, () => {
			const p = pick(r, c.paragraphs).split(" ");
			const lines: string[] = [];
			for (let k = 0; k < p.length; k += 6)
				lines.push(`${" ".repeat(int(r, 4, 24))}${p.slice(k, k + 6).join("   ")}${" ".repeat(int(r, 0, 30))}`);
			return `${lines.join("\n")}\n\n\n`;
		});
	}
	return { text: clip(text, size), source: `whitespace-heavy (${variant})` };
}

// ----------------------------------------------------------------------------------- images

function image(c: Corpus, r: R, size: number): Generated {
	const n = int(r, 1, 3);
	const images = Array.from({ length: n }, () => pick(r, c.images));
	const caption = fill(Math.min(size, 1_200), () => pick(r, c.paragraphs), " ");
	return {
		text: `Captured ${n} screenshot${n > 1 ? "s" : ""} (${images.map((im) => `${im.width}x${im.height}`).join(", ")}). ${caption}`,
		images: images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType })),
		source: `images: ${images.map((im) => im.path.split("/").pop()).join(", ")}`,
	};
}

// ----------------------------------------------------------------------------------- entry

function generateRaw(c: Corpus, r: R, kind: ContentClass, size: number): Generated {
	switch (kind) {
		case "prose":
			return prose(c, r, size);
		case "markup":
			return markup(c, r, size);
		case "code":
			return code(c, r, size);
		case "json":
			return json(c, r, size, false);
		case "json-min":
			return json(c, r, size, true);
		case "log":
			return log(c, r, size);
		case "table":
			return table(c, r, size);
		case "zh":
			return cjk(c, r, size, "zh");
		case "ja":
			return cjk(c, r, size, "ja");
		case "base64":
			return base64(c, r, size);
		case "whitespace":
			return whitespace(c, r, size);
		case "image":
			return image(c, r, size);
	}
}

export function generate(kind: ContentClass, size: number, seed: number): Generated {
	const generated = generateRaw(loadCorpus(), rng(hashSeed(kind, size, seed)), kind, size);
	return kind === "image" ? generated : { ...generated, text: clip(generated.text, size) };
}
