import { deflateRawSync } from "node:zlib";
import type { estimateTokens } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, NOTICE_TYPE } from "./options.ts";

export type AgentMessage = Parameters<typeof estimateTokens>[0];

// ================================================================== estimation (H1, H6)

/**
 * Tokens per character class, fitted by least squares (relative error, classes weighted equally) on
 * 4,000-character chunks of 14 content classes counted with o200k_base and GLM-5.3-Flash. Class-level
 * real/estimate ratios with these weights: 0.85-1.12 (chars / 4 gives 0.60-2.95).
 * Repetitive text is not among the classes (runs of one character, short repeated patterns, base64 of sparse data),
 * and textTokens overcounts it many times over (textTokensFloor).
 * The engine suite (h6-unit-density, calibration) checks the fit against both tokenizers.
 */
export const DENSITY = {
	cjk: 0.6693,
	base64: 0.6691,
	digit: 0.7624,
	punct: 0.6425,
	letter: 0.0739,
	wsRun: 1.4958,
	ws: 0.655,
	other: 0.7154,
};

export function isBase64Char(c: number): boolean {
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;
}

export function isCjk(c: number): boolean {
	return (
		(c >= 0x3000 && c <= 0x30ff) ||
		(c >= 0x3400 && c <= 0x9fff) ||
		(c >= 0xac00 && c <= 0xd7af) ||
		(c >= 0xff00 && c <= 0xffef)
	);
}

/** Estimated tokens of a text, from its character classes. */
export function textTokens(text: string): number {
	return Math.max(Math.ceil(classTokens(text)), Math.ceil(text.length / 8));
}

/** The sum of a text's character-class costs, before textTokens' lower bound of length / 8. */
function classTokens(text: string): number {
	let tokens = 0;
	const n = text.length;
	let i = 0;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (isBase64Char(c)) {
			let j = i;
			let letters = 0;
			let digits = 0;
			let punct = 0;
			while (j < n) {
				const d = text.charCodeAt(j);
				if (!isBase64Char(d)) break;
				if (d >= 48 && d <= 57) digits++;
				else if (d === 43 || d === 47 || d === 61) punct++;
				else letters++;
				j++;
			}
			tokens +=
				j - i >= 48
					? (j - i) * DENSITY.base64
					: letters * DENSITY.letter + digits * DENSITY.digit + punct * DENSITY.punct;
			i = j;
			continue;
		}
		if (c === 32 || c === 9) {
			let j = i;
			while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
			tokens += j - i >= 2 ? DENSITY.wsRun : DENSITY.ws;
			i = j;
			continue;
		}
		if (c === 10 || c === 13) tokens += DENSITY.ws;
		else if (isCjk(c)) tokens += DENSITY.cjk;
		else if (c < 128) tokens += DENSITY.punct;
		else {
			tokens += DENSITY.other;
			if (c >= 0xd800 && c <= 0xdbff) i++;
		}
		i++;
	}
	return tokens;
}

/** A run of 4 or more of one character that is not a letter, digit, space or tab. */
const RUN = /([^A-Za-z0-9 \t])\1{3,}/g;

/** ASCII punctuation: printable, not a letter, digit or space (+ / = included). */
function isAsciiPunct(c: number): boolean {
	return c >= 33 && c <= 126 && !(c >= 48 && c <= 57) && !(c >= 65 && c <= 90) && !(c >= 97 && c <= 122);
}

/**
 * The repetition bound of textTokensFloor: tokens per byte of those segments deflated. Fitted on honest tool output
 * counted with o200k and GLM-5.3-Flash, where base64 of sparse binary data (10% of bytes set) is the closest, at 0.61 of
 * this bound; at 1.8 the bound reaches E2's base64 of random data.
 */
export const FLOOR_TOKENS_PER_BYTE = 2;

/**
 * A lower bound on a text's real tokens, for the silent-truncation growth check. textTokens prices characters one
 * by one, and BPE vocabularies merge repetition: 2,000 dots are 32 tokens with o200k and with GLM-5.3-Flash, and
 * 1,285 by textTokens; base64 of 3,000 zero bytes is 500 and 2,677. The floor is the least of:
 * - textTokens;
 * - textTokens with each run of one character (RUN) at 1 + length / 64 (test dot reporters, rules, bars);
 * - the class costs without textTokens' lower bound of length / 8 (text that is mostly spaces);
 * - textTokens with the segments (segmentSlack) at FLOOR_TOKENS_PER_BYTE x their deflated size, when that is less than
 *   their price: runs of letters or digits, short repeated patterns, base64 and hex of sparse data, `-=-=` rules;
 * - the text with its runs of a short period (periodRuns) at periodRunCost, and the rest as the segment arm prices it:
 *   blank CRLF lines, lines of one tab or one space, and other repetition of whitespace, control characters and
 *   punctuation, alone or next to sparse data;
 * - as that, and with each run of whitespace that holds a line break at breakRunCost (breakFloor): blank lines of any
 *   count, trailing whitespace, indented blank lines, with no period needed; and with a run of one character that
 *   ends a line, or a short marker that starts one, priced with the breaks after it: rules and ellipses between
 *   blank lines, `//` and `#` comment lines, `>` quote lines.
 */
export function textTokensFloor(text: string): number {
	const classes = Math.ceil(classTokens(text));
	const estimate = Math.max(classes, Math.ceil(text.length / 8));
	let runs = 0;
	const rest = text.replace(RUN, (run) => {
		runs += 1 + run.length / 64;
		return "";
	});
	const runFloor = runs === 0 ? estimate : Math.ceil(textTokens(rest) + runs);
	const periods = periodRuns(text);
	return Math.min(
		estimate,
		runFloor,
		classes,
		estimate - segmentSlack(text),
		periodFloor(text, periods),
		breakFloor(text, periods),
	);
}

/** A character's class for a tokenizer's pre-split: 0 whitespace, 1 letter or mark, 2 digit, 3 anything else. */
function charClass(ch: string): number {
	if (/\s/u.test(ch)) return 0;
	if (/[\p{L}\p{M}]/u.test(ch)) return 1;
	if (/\p{N}/u.test(ch)) return 2;
	return 3;
}

/**
 * The longest period periodRuns looks for, in UTF-16 code units: a unit of up to 8 and its line ending (`\r\n`), so
 * that lines of a short pattern are one run. The sweep (floor-sweep.test.ts) found `\r\n\r\n\r\n\t` lines at 8.
 */
export const PERIOD_MAX = 10;
/** A run counts from this length and this many periods; shorter repetition (a `});` line twice) is ordinary text. */
const PERIOD_MIN_LENGTH = 32;
const PERIOD_MIN_REPEATS = 4;
/**
 * The step periodRuns tests at. A run of PERIOD_MIN_LENGTH or more, less its first period (at most PERIOD_MAX), still
 * spans 22 positions, so it holds a multiple of 16.
 */
const PERIOD_STRIDE = 16;

interface PeriodRun {
	start: number;
	end: number;
	period: number;
}

/**
 * The runs of a text with a period of 1 to PERIOD_MAX, at least PERIOD_MIN_LENGTH long and PERIOD_MIN_REPEATS periods,
 * longest first and not overlapping. Left out are runs textTokens already prices near their real count: runs only of
 * letters or only of digits (the base64 segments take those) and runs only of spaces and tabs (priced per run).
 */
function periodRuns(text: string): PeriodRun[] {
	const n = text.length;
	const found: PeriodRun[] = [];
	// Only every PERIOD_STRIDE-th position is tested; a match is widened to its whole run.
	for (let p = 1; p <= PERIOD_MAX; p++) {
		let covered = 0;
		for (let k = PERIOD_STRIDE; k < n; k += PERIOD_STRIDE) {
			if (k < covered || text.charCodeAt(k) !== text.charCodeAt(k - p)) continue;
			let a = k;
			while (a - 1 >= p && text.charCodeAt(a - 1) === text.charCodeAt(a - 1 - p)) a--;
			let b = k + 1;
			while (b < n && text.charCodeAt(b) === text.charCodeAt(b - p)) b++;
			covered = b;
			const start = a - p;
			if (b - start >= Math.max(PERIOD_MIN_LENGTH, PERIOD_MIN_REPEATS * p)) found.push({ start, end: b, period: p });
		}
	}
	found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.period - b.period || a.start - b.start);
	const taken = new Uint8Array(n);
	const runs: PeriodRun[] = [];
	for (const r of found) {
		let free = true;
		for (let k = r.start; k < r.end && free; k++) if (taken[k]) free = false;
		if (!free) continue;
		const unit = text.slice(r.start, r.start + r.period);
		if (/^[\p{L}\p{M}]+$/u.test(unit) || /^\p{N}+$/u.test(unit) || /^[ \t]+$/.test(unit)) continue;
		taken.fill(1, r.start, r.end);
		runs.push(r);
	}
	return runs;
}

/**
 * A run's floor. Within one character class a tokenizer can merge the whole run, so 1 + length / 64, as for a run of
 * one character. Across classes it merges at most over one change of class (o200k keeps punctuation and the newlines
 * after it together), so half a token per change of class in a period.
 */
function periodRunCost(text: string, r: PeriodRun): number {
	const unit = [...text.slice(r.start, r.start + r.period)];
	let changes = 0;
	for (let k = 0; k < unit.length; k++) if (charClass(unit[k]) !== charClass(unit[(k + 1) % unit.length])) changes++;
	const length = r.end - r.start;
	return changes === 0 ? 1 + length / 64 : (changes * length) / (2 * r.period);
}

/** The text with its short-period runs at periodRunCost, and the rest as the segment arm prices it. */
function periodFloor(text: string, runs: PeriodRun[]): number {
	if (runs.length === 0) return Number.POSITIVE_INFINITY;
	return withoutRuns(text, runs, (piece) => ({ rest: piece, cost: 0 }));
}

/** Maximal runs of whitespace (spaces, tabs, line breaks, Unicode spaces). */
const WHITESPACE = /\s+/gu;
const LINE_BREAK = /[\r\n]/;
/** One line break and the indentation after it: how ordinary text starts a line, which textTokens prices near its count. */
const LINE_START = /^(?:\r\n|\r|\n)[^\S\r\n]*$/;
const BREAK_RUN_BASE = 1.25;
const BREAK_RUN_PER_UNIT = 1 / 16;
/** A run of RUN that ends a line: only spaces or tabs and then a line break follow it. */
const RUN_BEFORE_BREAK = /([^A-Za-z0-9 \t\r\n])\1{3,}(?=[^\S\r\n]*[\r\n])/g;
/**
 * A marker of characters that are not letters, digits or whitespace (`//`, `#`, `>`, `|`, `-->`) at the start of a
 * line, with no indentation, and the whitespace after it. Indented markers stay out, so the closing brackets of nested
 * code and JSON keep their price.
 */
const MARKER_LINE = /(?<=^|[\r\n])([^\s\p{L}\p{N}]{1,3})\s+/gu;
/** The longest marker MARKER_LINE takes, in UTF-16 code units: an emoji counts two. */
const MARKER_MAX = 3;

/**
 * A whitespace run's floor when it holds a line break: tokenizers split it into one or a few pieces and merge
 * repeated breaks, so a run of any length and mix costs BREAK_RUN_BASE + length x BREAK_RUN_PER_UNIT. Fitted on the
 * floor sweep (floor-sweep.test.ts), which it keeps at 0.5 or more, with the fewest changes to E2's content.
 */
function breakRunCost(run: string): number {
	return BREAK_RUN_BASE + run.length * BREAK_RUN_PER_UNIT;
}

/**
 * As periodFloor, and with each run of whitespace that holds a line break, other than one break and its indentation,
 * at breakRunCost. Tokenizers take what ends a line with the breaks after it (o200k keeps punctuation and the line
 * breaks after it together), so before that, a run of one character that ends a line costs 1 + length / 64, as in
 * RUN, and a marker at the start of a line with whitespace after it that holds a line break (`//` comment lines,
 * `>` quote lines, `|` table edges) costs breakRunCost of the marker and the whitespace together.
 */
function breakFloor(text: string, runs: PeriodRun[]): number {
	return withoutRuns(text, runs, (piece) => {
		let cost = 0;
		const rest = piece
			.replace(RUN_BEFORE_BREAK, (run) => {
				cost += 1 + run.length / 64;
				return "";
			})
			.replace(MARKER_LINE, (line, marker: string) => {
				if (marker.length > MARKER_MAX || !LINE_BREAK.test(line)) return line;
				cost += breakRunCost(line);
				return "";
			})
			.replace(WHITESPACE, (w) => {
				if (!LINE_BREAK.test(w) || LINE_START.test(w)) return w;
				cost += breakRunCost(w);
				return "";
			});
		return { rest, cost };
	});
}

/**
 * The floor of a text with its short-period runs at periodRunCost and each piece between them passed through `cut`,
 * which takes out what it prices itself; the rest as the segment arm prices it.
 */
function withoutRuns(text: string, runs: PeriodRun[], cut: (piece: string) => { rest: string; cost: number }): number {
	const sorted = [...runs].sort((a, b) => a.start - b.start);
	let rest = "";
	let at = 0;
	let cost = 0;
	const take = (piece: string) => {
		const c = cut(piece);
		rest += c.rest;
		cost += c.cost;
	};
	for (const r of sorted) {
		take(text.slice(at, r.start));
		cost += periodRunCost(text, r);
		at = r.end;
	}
	take(text.slice(at));
	return Math.ceil(classTokens(rest) - segmentSlack(rest) + cost);
}

/**
 * What textTokens charges for a text's segments over FLOOR_TOKENS_PER_BYTE x their deflated size, if more. The
 * segments are what textTokens prices character by character and tokenizers merge when they repeat: runs of 48 or
 * more base64 characters (textTokens' flat base64 price) and runs of 8 or more ASCII punctuation characters (a run
 * starts at its first character: a base64 run at a letter, digit, + / or =, a punctuation run at other punctuation).
 */
function segmentSlack(text: string): number {
	const segments: string[] = [];
	let price = 0;
	const n = text.length;
	let i = 0;
	while (i < n) {
		const c = text.charCodeAt(i);
		const base64 = isBase64Char(c);
		if (!base64 && !isAsciiPunct(c)) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < n && (base64 ? isBase64Char(text.charCodeAt(j)) : isAsciiPunct(text.charCodeAt(j)))) j++;
		if (base64 ? j - i >= 48 : j - i >= 8) {
			segments.push(text.slice(i, j));
			price += (j - i) * (base64 ? DENSITY.base64 : DENSITY.punct);
		}
		i = j;
	}
	if (segments.length === 0) return 0;
	const packed = FLOOR_TOKENS_PER_BYTE * deflateRawSync(Buffer.from(segments.join("\n"), "utf8")).length;
	return Math.max(0, Math.floor(price - packed));
}

export const floorSlackCache = new WeakMap<object, number>();

/**
 * Estimated tokens of a message's text that textTokensFloor takes off (runs and other repetition): textTokens less
 * textTokensFloor, over the text, the command and output, and the tool-call arguments it sends (cached per message
 * object, as messageTokens).
 */
export function messageFloorSlack(message: AgentMessage): number {
	const cached = floorSlackCache.get(message);
	if (cached !== undefined) return cached;
	const m = message as Record<string, unknown> & { role: string };
	const of = (text: string) => textTokens(text) - textTokensFloor(text);
	let slack = 0;
	const content = m.role === "bashExecution" ? `${m.command ?? ""}\n${m.output ?? ""}` : m.content;
	if (typeof content === "string") slack += of(content);
	else if (Array.isArray(content))
		for (const block of content as Block[]) {
			if (block.type === "text") slack += of(block.text ?? "");
			else if (block.type === "toolCall") slack += of(JSON.stringify(block.arguments ?? {}));
		}
	floorSlackCache.set(message, slack);
	return slack;
}

/** Width and height from a base64 PNG, GIF or JPEG header. */
export function imageSize(data: string): { width: number; height: number } | undefined {
	try {
		const head = Buffer.from(data.slice(0, 44), "base64");
		if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
			return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
		}
		if (head.length >= 10 && head.toString("ascii", 0, 4) === "GIF8") {
			return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
		}
		if (head[0] === 0xff && head[1] === 0xd8) {
			const bytes = Buffer.from(data.slice(0, 87_384), "base64");
			let i = 2;
			while (i + 9 < bytes.length && bytes[i] === 0xff) {
				const marker = bytes[i + 1];
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
				}
				i += 2 + bytes.readUInt16BE(i + 2);
			}
		}
	} catch {}
	return undefined;
}

export let defaultImageTokens = DEFAULTS.defaultImageTokens;

/** The cost of an image whose size cannot be read (the defaultImageTokens option; shared by all instances). */
export function setDefaultImageTokens(value: number): void {
	defaultImageTokens = value;
}

/** Estimated image tokens: Anthropic's width x height / 750, at most 1,600 after its resize. */
export function imageTokens(image: { data: string }): number {
	const size = imageSize(image.data);
	return size ? Math.max(85, Math.min(1_600, Math.ceil((size.width * size.height) / 750))) : defaultImageTokens;
}

export type Block = {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	data?: string;
};

export function blocksTokens(content: unknown): number {
	if (typeof content === "string") return textTokens(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content as Block[]) {
		if (block.type === "text") tokens += textTokens(block.text ?? "");
		else if (block.type === "image") tokens += imageTokens(block as { data: string });
		else if (block.type === "thinking") tokens += textTokens(block.thinking ?? "");
		else if (block.type === "toolCall")
			tokens += textTokens(`${block.name} ${JSON.stringify(block.arguments ?? {})}`) + 8;
	}
	return tokens;
}

export const tokenCache = new WeakMap<object, number>();

/** Estimated tokens of one message (cached per message object; session messages are immutable). */
export function messageTokens(message: AgentMessage): number {
	const cached = tokenCache.get(message);
	if (cached !== undefined) return cached;
	const m = message as Record<string, unknown> & { role: string };
	let tokens = 4;
	switch (m.role) {
		case "system": {
			tokens += blocksTokens(m.content);
			for (const section of Object.values((m.sections as Record<string, string | null>) ?? {})) {
				if (section) tokens += textTokens(section);
			}
			if (m.toolsAdded) tokens += textTokens(JSON.stringify(m.toolsAdded));
			if (m.toolsRemoved) tokens += textTokens(JSON.stringify(m.toolsRemoved));
			break;
		}
		case "toolResult":
			tokens += textTokens(String(m.toolName ?? "")) + blocksTokens(m.content);
			break;
		case "bashExecution":
			tokens += textTokens(`${m.command ?? ""}\n${m.output ?? ""}`);
			break;
		case "compactionSummary":
		case "branchSummary":
			tokens += textTokens(String(m.summary ?? "")) + 30;
			break;
		default:
			tokens += blocksTokens(m.content);
	}
	tokenCache.set(message, tokens);
	return tokens;
}

/** Estimated image tokens in one message (images are left out of the silent-truncation evidence). */
export function messageImageTokens(message: AgentMessage): number {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content as Block[]) if (block.type === "image") tokens += imageTokens(block as { data: string });
	return tokens;
}

/**
 * Identities of a request's messages (role, timestamp, custom type), without a trailing
 * request-only notice, and that notice's estimate. Two requests where the first's keys are a prefix
 * of the second's differ only by appended messages.
 */
export function requestShape(messages: AgentMessage[]): { keys: string[]; noticeTokens: number } {
	const keys = messages.map((m) => {
		const r = m as { role: string; timestamp?: number; customType?: string };
		return `${r.role}:${r.timestamp ?? 0}:${r.customType ?? ""}`;
	});
	const last = messages.at(-1) as { role?: string; customType?: string } | undefined;
	if (last?.role === "custom" && last.customType === NOTICE_TYPE) {
		keys.pop();
		return { keys, noticeTokens: messageTokens(messages.at(-1)!) };
	}
	return { keys, noticeTokens: 0 };
}

export function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments)})`;
			return "";
		})
		.join("\n");
}

// ================================================================== overflow parsing (E5)

export const NUMBER = "([\\d,]+)";

export const LIMIT_PATTERNS = [
	`>\\s*${NUMBER}\\s*maximum`,
	`maximum context length is ${NUMBER}`,
	`maximum context length of ${NUMBER}`,
	`maximum context length \\(${NUMBER}\\)`,
	`maximum context length: ${NUMBER}`,
	`context length \\(${NUMBER} tokens\\)`,
	`tokens allowed \\(${NUMBER}\\)`,
	`limit of ${NUMBER}`,
	`context size is ${NUMBER}`,
	`maximum prompt length is ${NUMBER}`,
].map((p) => new RegExp(p, "i"));

export const REQUEST_PATTERNS = [
	`${NUMBER} tokens? >`,
	`requested (?:about )?${NUMBER} tokens`,
	`request contains ${NUMBER} tokens`,
	`input token count \\(${NUMBER}\\)`,
	`input length \\(?${NUMBER}\\)? exceeds`,
	`prompt has ${NUMBER} tokens`,
	`prompt token count of ${NUMBER}`,
	`the input \\(${NUMBER} tokens\\)`,
	`prompt contains ${NUMBER} tokens`,
	`messages resulted in ${NUMBER} tokens`,
	`your request has ${NUMBER} input tokens`,
	`too long: ${NUMBER}`,
].map((p) => new RegExp(p, "i"));

export function firstNumber(patterns: RegExp[], text: string | undefined): number | undefined {
	if (!text) return undefined;
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) return Number(match[1].replace(/,/g, ""));
	}
	return undefined;
}

/** The provider's stated limit, and the size it counted for the rejected request, when the error says. */
export function parseOverflow(errorMessage: string | undefined): { limit?: number; requested?: number } {
	return { limit: firstNumber(LIMIT_PATTERNS, errorMessage), requested: firstNumber(REQUEST_PATTERNS, errorMessage) };
}
