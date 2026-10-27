import type { estimateTokens } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, NOTICE_TYPE } from "./options.ts";

export type AgentMessage = Parameters<typeof estimateTokens>[0];

// ================================================================== estimation (H1, H6)

/**
 * Tokens per character class, fitted by least squares (relative error, classes weighted equally) on
 * 4,000-character chunks of 14 content classes counted with o200k_base and GLM-5.3-Flash. Class-level
 * real/estimate ratios with these weights: 0.85-1.12 (chars / 4 gives 0.60-2.95).
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
	return Math.max(Math.ceil(tokens), Math.ceil(n / 8));
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
