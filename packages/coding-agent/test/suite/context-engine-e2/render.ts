/**
 * Renders a Pi request (TranscriptContext) the way an OpenAI-compatible server sees it, then counts it
 * with a real tokenizer. Two templates:
 *
 *   o200k  OpenAI chat format (GPT-4o / GPT-4.1). The ChatML control tokens are not in the public
 *          o200k_base encoder, so the framing is added as constants from OpenAI's cookbook "How to count
 *          tokens with tiktoken": 3 tokens per message (<|im_start|>, <|im_sep|>, <|im_end|>) plus the
 *          role name, and 3 tokens priming the reply. Each tool call adds 3 tokens plus
 *          "functions.<name>" and its JSON arguments (OpenAI publishes no number; this mirrors the
 *          per-message rule). Tool schemas are rendered as OpenAI's internal TypeScript "namespace
 *          functions" block appended to the system message and tokenized.
 *   glm    GLM-5.3-Flash chat_template.jinja (huggingface.co/zai-org/GLM-5.3-Flash), rendered for the
 *          features Pi uses (whitespace normalized) and tokenized INCLUDING its special tokens
 *          ([gMASK], <sop>, <|system|>, <|user|>, <|assistant|>, <|observation|>, <think>, <tool_call>,
 *          <arg_key>, <tool_response>, ...): the per-message overhead is whatever the template adds
 *          (e.g. 1 token for <|user|>, 3 for <|assistant|><think></think>, 2 per <tool_response>).
 *
 * Messages are first normalized like Pi's openai-completions provider (convertMessages): system messages
 * collapse into one leading system message with the current tools, tool results become `tool` messages,
 * and their images move into a following user message "Attached image(s) from tool result:".
 *
 * Images (per provider):
 *   o200k  OpenAI high-detail rule: fit in 2048x2048, scale the shortest side down to 768, then
 *          85 + 170 tokens per 512x512 tile.
 *   glm    GLM-5.3-Flash processor_config.json: 14px patches merged 2x2 (28px per token), smart-resized to
 *          multiples of 28 within [16, 8000] tokens, plus <|begin_of_image|> and <|end_of_image|>.
 *   (The engine's own estimate uses Anthropic's rule: w*h/750, at most 1,600.)
 *
 * The request is a list of segments; each starts at a special token, so a request's count is the sum of
 * its segments' counts (sim.e2.ts checks this against tokenizing the whole prompt).
 */

import { createHash } from "node:crypto";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import type { CountingTokenizer, TokenizerName } from "./tokenizers.ts";

/** Compact identity of a rendered segment. */
function keyOf(text: string): string {
	return text.length < 48 ? text : `${text.length}#${createHash("sha1").update(text).digest("base64")}`;
}

export interface Segment {
	/** Stable identity of the rendered segment (for prefix analysis). */
	key: string;
	tokens: number;
	imageTokens: number;
	/** Part of the request that is not a message prefix: the reply priming at the end. */
	tail?: boolean;
	/** Contains the engine's request-only notice marker. */
	notice?: boolean;
	role: string;
	/** E2_DUMP_DROPPED only: the segment's first characters (what a silent truncation removed). */
	head?: string;
}

export interface RenderedRequest {
	segments: Segment[];
	tokens: number;
	imageTokens: number;
	images: number;
}

interface Image {
	data: string;
	mimeType: string;
}

/** Normalized OpenAI-chat message. */
type ChatMessage =
	| { role: "system"; text: string; tools: Array<{ name: string; description?: string; parameters?: unknown }> }
	| { role: "user"; text: string; images: Image[] }
	| {
			role: "assistant";
			text: string;
			toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
			/**
			 * P3 (B5): reasoning Pi's openai-completions converter replays on a message it sends (a thinking block
			 * with a reasoning signature, on a message with text or a tool call); counted unless
			 * E2_REASONING_COUNT=ignored (a provider that ignores replayed reasoning). Absent without thinking.
			 */
			reasoning?: string;
	  }
	| { role: "tool"; text: string; name: string };

// ------------------------------------------------------------------------------------ images

/** Width and height from a base64 PNG, GIF or JPEG header. */
export function imageSize(data: string): { width: number; height: number } | undefined {
	try {
		const head = Buffer.from(data.slice(0, 44), "base64");
		if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47)
			return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
		if (head.length >= 10 && head.toString("ascii", 0, 4) === "GIF8")
			return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
		if (head[0] === 0xff && head[1] === 0xd8) {
			const bytes = Buffer.from(data.slice(0, 87_384), "base64");
			let i = 2;
			while (i + 9 < bytes.length && bytes[i] === 0xff) {
				const marker = bytes[i + 1];
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
					return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
				i += 2 + bytes.readUInt16BE(i + 2);
			}
		}
	} catch {}
	return undefined;
}

/** OpenAI GPT-4o / GPT-4.1 image input, detail "high" (what "auto" picks for large images). */
export function openaiImageTokens(width: number, height: number): number {
	let w = width;
	let h = height;
	if (Math.max(w, h) > 2048) {
		const s = 2048 / Math.max(w, h);
		w *= s;
		h *= s;
	}
	if (Math.min(w, h) > 768) {
		const s = 768 / Math.min(w, h);
		w *= s;
		h *= s;
	}
	return 85 + 170 * Math.ceil(Math.floor(w) / 512) * Math.ceil(Math.floor(h) / 512);
}

/** GLM-5.3-Flash: Qwen2-VL style smart_resize with factor 28 (patch 14, merge 2), 16..8000 tokens, + 2 markers. */
export function glmImageTokens(width: number, height: number): number {
	const factor = 28;
	const minPixels = 16 * factor * factor;
	const maxPixels = 8000 * factor * factor;
	let h = Math.max(factor, Math.round(height / factor) * factor);
	let w = Math.max(factor, Math.round(width / factor) * factor);
	if (h * w > maxPixels) {
		const beta = Math.sqrt((height * width) / maxPixels);
		h = Math.floor(height / beta / factor) * factor;
		w = Math.floor(width / beta / factor) * factor;
	} else if (h * w < minPixels) {
		const beta = Math.sqrt(minPixels / (height * width));
		h = Math.ceil((height * beta) / factor) * factor;
		w = Math.ceil((width * beta) / factor) * factor;
	}
	return (h / factor) * (w / factor) + 2;
}

/** Anthropic's published rule (what the engine estimates): w*h/750, at most ~1,600 after its resize. */
export function anthropicImageTokens(width: number, height: number): number {
	return Math.min(1_600, Math.ceil((width * height) / 750));
}

export function imageTokensFor(tokenizer: TokenizerName, image: Image): number {
	const size = imageSize(image.data) ?? { width: 1024, height: 1024 };
	return tokenizer === "o200k" ? openaiImageTokens(size.width, size.height) : glmImageTokens(size.width, size.height);
}

// ------------------------------------------------------------------------------------ normalize

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type: string; text?: string }>)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

function imagesOf(content: unknown): Image[] {
	if (!Array.isArray(content)) return [];
	return (content as Array<{ type: string; data?: string; mimeType?: string }>)
		.filter((b) => b.type === "image" && b.data)
		.map((b) => ({ data: b.data!, mimeType: b.mimeType ?? "image/png" }));
}

/** Pi's openai-completions convertMessages, reduced to what changes the prompt text. */
export function normalize(context: TranscriptContext): ChatMessage[] {
	const out: ChatMessage[] = [];
	const system = getCurrentSystemMessage(context.messages);
	if (system) {
		out.push({
			role: "system",
			text: getSystemMessageText(system),
			tools: (system.toolsAdded ?? []).map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			})),
		});
	}
	const messages = context.messages.filter((m) => m.role !== "system") as Message[];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "user") {
			const text =
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((b) => b.type === "text" && b.text.length > 0)
							.map((b) => (b as { text: string }).text)
							.join("\n");
			const images = imagesOf(m.content);
			if (text.length === 0 && images.length === 0) continue;
			out.push({ role: "user", text, images });
		} else if (m.role === "assistant") {
			const text = m.content
				.filter((b) => b.type === "text" && b.text.trim().length > 0)
				.map((b) => (b as { text: string }).text)
				.join("");
			const toolCalls = m.content
				.filter((b) => b.type === "toolCall")
				.map((b) => {
					const call = b as { name: string; arguments: Record<string, unknown> };
					return { name: call.name, arguments: call.arguments ?? {} };
				});
			// Pi's converter skips an assistant message with no text and no tool call (a reasoning-only answer).
			if (text.length === 0 && toolCalls.length === 0) continue;
			const reasoning = m.content
				.filter((b) => b.type === "thinking" && b.thinking.trim().length > 0 && !!b.thinkingSignature)
				.map((b) => (b as { thinking: string }).thinking)
				.join("\n");
			const counted = reasoning.length > 0 && process.env.E2_REASONING_COUNT !== "ignored";
			out.push({ role: "assistant", text, toolCalls, ...(counted ? { reasoning } : {}) });
		} else if (m.role === "toolResult") {
			const images: Image[] = [];
			let j = i;
			for (; j < messages.length && messages[j].role === "toolResult"; j++) {
				const result = messages[j] as Extract<Message, { role: "toolResult" }>;
				const text = textOf(result.content);
				const own = imagesOf(result.content);
				images.push(...own);
				out.push({
					role: "tool",
					name: result.toolName,
					text: text.length > 0 ? text : own.length > 0 ? "(see attached image)" : "(no tool output)",
				});
			}
			i = j - 1;
			if (images.length > 0) out.push({ role: "user", text: "Attached image(s) from tool result:", images });
		}
	}
	return out;
}

// ------------------------------------------------------------------------------------ o200k

type JsonSchema = {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	const?: unknown;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
};

function tsType(schema: JsonSchema | undefined, indent: string): string {
	if (!schema) return "any";
	if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	const union = schema.anyOf ?? schema.oneOf;
	if (union) return union.map((s) => tsType(s, indent)).join(" | ");
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return `${tsType(schema.items, indent)}[]`;
		case "object": {
			if (!schema.properties) return "object";
			const lines = Object.entries(schema.properties).flatMap(([key, prop]) => [
				...(prop.description ? [`${indent}// ${prop.description}`] : []),
				`${indent}${key}${schema.required?.includes(key) ? "" : "?"}: ${tsType(prop, `${indent}  `)},`,
			]);
			return `{\n${lines.join("\n")}\n${indent.slice(2)}}`;
		}
		default:
			return "any";
	}
}

/** OpenAI's rendering of function definitions inside the system prompt. */
export function openaiToolsBlock(tools: Array<{ name: string; description?: string; parameters?: unknown }>): string {
	if (tools.length === 0) return "";
	const fns = tools.map((t) => {
		const params = t.parameters as JsonSchema | undefined;
		const hasParams = params?.properties && Object.keys(params.properties).length > 0;
		return `${t.description ? `// ${t.description}\n` : ""}type ${t.name} = (${hasParams ? `_: ${tsType(params, "")}` : ""}) => any;`;
	});
	return `\n\n# Tools\n\n## functions\n\nnamespace functions {\n\n${fns.join("\n\n")}\n\n} // namespace functions`;
}

function renderO200k(messages: ChatMessage[], tok: CountingTokenizer, notice?: string): RenderedRequest {
	const segments: Segment[] = [];
	const role = (r: string) => tok.count(r);
	for (const m of messages) {
		let text: string;
		let tokens: number;
		let imageTokens = 0;
		if (m.role === "system") {
			text = m.text + openaiToolsBlock(m.tools);
			tokens = 3 + role("system") + tok.count(text);
		} else if (m.role === "user") {
			text = m.text;
			imageTokens = m.images.reduce((s, image) => s + imageTokensFor("o200k", image), 0);
			tokens = 3 + role("user") + tok.count(text) + imageTokens;
			if (m.images.length > 0)
				text += `\u0000${m.images.map((i) => `${i.data.length}:${i.data.slice(-32)}`).join(",")}`;
		} else if (m.role === "assistant") {
			const calls = m.toolCalls.map((c) => ({ name: `functions.${c.name}`, args: JSON.stringify(c.arguments) }));
			text = `${m.text}\u0000${calls.map((c) => `${c.name}\u0001${c.args}`).join("\u0002")}`;
			tokens = 3 + role("assistant") + tok.count(m.text);
			if (m.reasoning) {
				text = `${m.reasoning}\u0004${text}`;
				tokens += tok.count(m.reasoning);
			}
			for (const c of calls) tokens += 3 + tok.count(c.name) + tok.count(c.args);
		} else {
			text = m.text;
			tokens = 3 + role("tool") + tok.count(text);
		}
		segments.push({
			key: keyOf(`${m.role}\u0003${text}`),
			tokens,
			imageTokens,
			role: m.role,
			notice: notice !== undefined && m.text.includes(notice),
			...(DUMP_HEADS ? { head: m.text.slice(0, 240) } : {}),
		});
	}
	segments.push({ key: "reply-priming", tokens: 3, imageTokens: 0, tail: true, role: "priming" });
	return summarize(segments, messages);
}

// ------------------------------------------------------------------------------------ glm

/** Python json.dumps(ensure_ascii=False) with the default separators (", ", ": "), as Jinja's tojson. */
export function pyJson(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`)
		.join(", ")}}`;
}

const GLM_TOOLS_HEAD =
	"<|system|>\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n";
const GLM_TOOLS_TAIL =
	"</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value><arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>";

interface GlmPart {
	role: string;
	text: string;
	imageTokens: number;
	extraKey: string;
	tail?: boolean;
}

/** The template's text, one part per message (each part starts at a special token). */
function glmParts(messages: ChatMessage[]): GlmPart[] {
	const parts: GlmPart[] = [];
	const push = (role: string, text: string, imageTokens = 0, extraKey = "") =>
		parts.push({ role, text, imageTokens, extraKey });
	// The template always opens with the prompt prefix and its reasoning-effort system line (default "max").
	push("prefix", "[gMASK]<sop><|system|>Reasoning Effort: Max");
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "system") {
			if (m.tools.length > 0) {
				const tools = m.tools
					.map((t) => `${pyJson({ name: t.name, description: t.description, parameters: t.parameters })}\n`)
					.join("");
				push("tools", GLM_TOOLS_HEAD + tools + GLM_TOOLS_TAIL);
			}
			push("system", `<|system|>${m.text}`);
		} else if (m.role === "user") {
			// Each image renders as <|begin_of_image|><|image|><|end_of_image|> with <|image|> expanded to the
			// patch count; glmImageTokens already includes the two markers.
			push(
				"user",
				`<|user|>${m.text}`,
				m.images.reduce((s, image) => s + imageTokensFor("glm", image), 0),
				m.images.map((im) => `\u0000${im.data.length}:${im.data.slice(-32)}`).join(""),
			);
		} else if (m.role === "assistant") {
			let text = `<|assistant|><think>${m.reasoning ?? ""}</think>${m.text.trim()}`;
			if (m.toolCalls.length > 0) {
				text += "\n";
				for (const call of m.toolCalls) {
					text += `<tool_call>${call.name}`;
					for (const [k, v] of Object.entries(call.arguments))
						text += `<arg_key>${k}</arg_key><arg_value>${typeof v === "string" ? v : pyJson(v)}</arg_value>`;
					text += "</tool_call>";
				}
				text += "\n";
			}
			push("assistant", text);
		} else {
			const first = i === 0 || messages[i - 1].role !== "tool";
			push("tool", `${first ? "<|observation|>" : ""}<tool_response>${m.text}</tool_response>`);
		}
	}
	parts.push({ role: "priming", text: "<|assistant|><think>", imageTokens: 0, extraKey: "", tail: true });
	return parts;
}

function renderGlm(messages: ChatMessage[], tok: CountingTokenizer, notice?: string): RenderedRequest {
	const segments: Segment[] = glmParts(messages).map((p) => ({
		key: keyOf(`${p.role}\u0003${p.text}${p.extraKey}`),
		tokens: tok.count(p.text) + p.imageTokens,
		imageTokens: p.imageTokens,
		role: p.role,
		tail: p.tail,
		notice: notice !== undefined && p.text.includes(notice),
		...(DUMP_HEADS ? { head: p.text.slice(0, 240) } : {}),
	}));
	return summarize(segments, messages);
}

/** E2_DUMP_DROPPED: keep each segment's first characters, for the dropped-content dump (provider-sim.ts). */
const DUMP_HEADS = !!process.env.E2_DUMP_DROPPED;

function summarize(segments: Segment[], messages: ChatMessage[]): RenderedRequest {
	return {
		segments,
		tokens: segments.reduce((s, x) => s + x.tokens, 0),
		imageTokens: segments.reduce((s, x) => s + x.imageTokens, 0),
		images: messages.reduce((s, m) => s + (m.role === "user" ? m.images.length : 0), 0),
	};
}

export function renderRequest(
	context: TranscriptContext,
	tokenizer: TokenizerName,
	tok: CountingTokenizer,
	noticeMarker?: string,
): RenderedRequest {
	const messages = normalize(context);
	return tokenizer === "o200k" ? renderO200k(messages, tok, noticeMarker) : renderGlm(messages, tok, noticeMarker);
}

/** The full GLM prompt text (sim.e2.ts: segment counts must add up to the whole prompt's count). */
export function glmPromptText(context: TranscriptContext): string {
	return glmParts(normalize(context))
		.map((p) => p.text)
		.join("");
}
