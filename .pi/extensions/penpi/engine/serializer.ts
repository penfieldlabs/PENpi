import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EngineCore } from "./core.ts";
import { type AgentMessage, type Block, imageTokens, messageTokens, textTokens } from "./estimator.ts";

/**
 * The model a request is serialized for. Pi's converters decide per API (and, for assistant
 * messages, whether the message came from this same model) what of a message goes on the wire.
 */
export interface SerializeTarget {
	api: string;
	provider: string;
	modelId: string;
	/** openai-completions compat.requiresThinkingAsText: reasoning is replayed as assistant text. */
	thinkingAsText: boolean;
	/**
	 * The converter whose rules apply (serializeAs), when it differs from `api` (a provider registered under
	 * its own API name that sends through Pi's openai-completions converter, or a test's faux model).
	 * Same-model checks still use `api`.
	 */
	converter?: string;
}

/** APIs whose converters the estimate models; any other API counts every block. */
export const MODELLED_APIS = ["openai-completions", "anthropic-messages", "bedrock-converse-stream"] as const;

/** openai-completions: the reasoning fields a thinking signature may name (OPENAI_COMPLETIONS_REASONING_FIELDS). */
export const OPENAI_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"];

/** openai-completions: a signature holding reasoning_details (parseOpenAIReasoningDetails: a non-empty JSON array of text, summary or encrypted details). */
/** D4: a tool call's legacy thoughtSignature that openai-completions replays as an encrypted reasoning detail. */
export function isLegacyEncryptedDetail(signature: string | undefined): boolean {
	if (!signature || signature[0] !== "{") return false;
	try {
		const d = JSON.parse(signature) as Record<string, unknown>;
		return (
			d?.type === "reasoning.encrypted" &&
			typeof d.id === "string" &&
			d.id.length > 0 &&
			typeof d.data === "string" &&
			d.data.length > 0
		);
	} catch {
		return false;
	}
}

export function isReasoningDetails(signature: string | undefined): boolean {
	if (!signature || signature[0] !== "[") return false;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every((d) => {
				if (!d || typeof d !== "object" || Array.isArray(d)) return false;
				const r = d as Record<string, unknown>;
				if (r.type === "reasoning.text") return typeof r.text === "string";
				if (r.type === "reasoning.summary") return typeof r.summary === "string";
				if (r.type === "reasoning.encrypted") return typeof r.data === "string";
				return false;
			})
		);
	} catch {
		return false;
	}
}

/** transform-messages.ts (Pi 1.4.0): what an error tool result with images is sent with besides its own blocks. */
export const ERROR_TOOL_IMAGE_PLACEHOLDER = "(image attached after the tool results)";

/**
 * 0.6.0 (Pi 1.4.0, splitErrorToolResultImages): anthropic-messages, and bedrock-converse-stream for a Claude model,
 * reject images in an error tool result. Pi sends the result with each run of images replaced by a placeholder line,
 * and the images after all tool results under a caption naming the call. The images are counted in messageTokens;
 * this is the placeholders and the caption. (Bedrock's check also reads the model's name; the engine sees its id,
 * which carries "claude" for Claude models.)
 */
function errorImageCaptionTokens(message: AgentMessage, target: SerializeTarget | undefined): number {
	if (!target) return 0;
	const api = target.converter ?? target.api;
	const claudeOnBedrock = api === "bedrock-converse-stream" && /claude/i.test(target.modelId);
	if (api !== "anthropic-messages" && !claudeOnBedrock) return 0;
	const result = message as { isError?: boolean; content?: unknown; toolCallId?: string; toolName?: string };
	if (!result.isError || !Array.isArray(result.content)) return 0;
	let runs = 0;
	let previousImage = false;
	for (const block of result.content as Block[]) {
		const image = block.type === "image";
		if (image && !previousImage) runs++;
		previousImage = image;
	}
	if (runs === 0) return 0;
	const caption = `Images from the error result of tool call ${result.toolCallId} (${result.toolName}):`;
	return runs * textTokens(ERROR_TOOL_IMAGE_PLACEHOLDER) + textTokens(caption);
}

/**
 * Estimated tokens of one message as Pi serializes it for `target`, and the part of them that is
 * replayed reasoning. Rules (packages/ai/src/api, Pi 1.4.0):
 *   every modelled API (transform-messages.ts): an assistant message that ended in error or was aborted
 *     is not sent; thinking from another model is dropped, redacted or not (Pi 1.1.0 sent non-empty
 *     thinking from another model as plain text); empty thinking without a same-model signature is
 *     dropped.
 *   openai-completions: blank text is dropped; thinking is sent only as reasoning_details (a signature
 *     holding them), as the reasoning field its signature names, or as text when
 *     compat.requiresThinkingAsText; an assistant message with no text and no tool call is not sent at
 *     all (reasoning-only), unless its thinking goes as text.
 *   anthropic-messages: blank text is dropped; thinking is sent (signed, or as text when unsigned);
 *     redacted thinking is sent as its opaque payload; a message with no blocks left is not sent.
 *   bedrock-converse-stream: as anthropic; a message with no blocks left is not sent.
 *   tool results: as messageTokens; an error result with images, for anthropic-messages and Claude on Bedrock, adds
 *     a placeholder line per run of images and a caption naming the call (errorImageCaptionTokens).
 *   user messages (all three): blank text is dropped; a message with nothing left is not sent
 *     (Bedrock sends a placeholder: counted as the message overhead).
 *   any other API: every block counts (messageTokens), its thinking as reasoning.
 * Images count as in messageTokens. The 4-token message overhead counts only for messages sent.
 */
export function serializedParts(
	message: AgentMessage,
	target?: SerializeTarget,
): { tokens: number; reasoning: number; asText?: number } {
	const all = messageTokens(message);
	const role = message.role;
	if (role === "toolResult") return { tokens: all + errorImageCaptionTokens(message, target), reasoning: 0 };
	if (role !== "assistant" && role !== "user") return { tokens: all, reasoning: 0 };
	const content = (message as { content?: unknown }).content;
	const modelled = !!target && (MODELLED_APIS as readonly string[]).includes(target.converter ?? target.api);
	if (!modelled) {
		const reasoning =
			role === "assistant" && Array.isArray(content)
				? (content as Block[]).reduce(
						(sum, b) => sum + (b.type === "thinking" ? textTokens(b.thinking ?? "") : 0),
						0,
					)
				: 0;
		return { tokens: all, reasoning };
	}
	const api = target!.converter ?? target!.api;
	if (role === "user") {
		// D4: openai-completions sends string content as it is, blank included.
		if (typeof content === "string")
			return content.trim().length > 0 || api !== "anthropic-messages"
				? { tokens: all, reasoning: 0 }
				: { tokens: 0, reasoning: 0 };
		const blocks = Array.isArray(content) ? (content as Block[]) : [];
		let tokens = 0;
		let kept = 0;
		for (const b of blocks) {
			// D4: openai-completions drops only empty text blocks; the others drop blank ones.
			const text = b.text ?? "";
			if (b.type === "text" && (api === "openai-completions" ? text.length > 0 : text.trim().length > 0)) {
				tokens += textTokens(text);
				kept++;
			} else if (b.type === "image") {
				tokens += imageTokens(b as { data: string });
				kept++;
			}
		}
		if (kept === 0)
			return api === "bedrock-converse-stream" ? { tokens: 4, reasoning: 0 } : { tokens: 0, reasoning: 0 };
		return { tokens: 4 + tokens, reasoning: 0 };
	}
	const assistant = message as AssistantMessage;
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return { tokens: 0, reasoning: 0 };
	const sameModel =
		assistant.provider === target!.provider && assistant.api === target!.api && assistant.model === target!.modelId;
	const blocks = (Array.isArray(content) ? content : []) as Array<
		Block & { thinkingSignature?: string; redacted?: boolean }
	>;
	let text = 0;
	let tools = 0;
	let reasoning = 0;
	let thinkingAsText = 0;
	let kept = 0;
	// D4 (openai-completions): Pi attaches reasoning_details from the first thinking signature that holds them,
	// whatever the thinking text (empty included) and also with requiresThinkingAsText; failing that, from
	// the tool calls' thoughtSignature (legacy encrypted reasoning). Same-model only (transformMessages).
	let details = 0;
	let openaiThinking = 0;
	let openaiField = false;
	if (api === "openai-completions" && sameModel) {
		const signed = blocks.find((b) => b.type === "thinking" && isReasoningDetails(b.thinkingSignature));
		if (signed) details = textTokens(signed.thinkingSignature!);
		else
			for (const b of blocks)
				if (b.type === "toolCall" && isLegacyEncryptedDetail((b as { thoughtSignature?: string }).thoughtSignature))
					details += textTokens((b as { thoughtSignature?: string }).thoughtSignature!);
		// Without reasoning_details, the first non-empty thinking block's signature names the reasoning field.
		const first = blocks.find((b) => b.type === "thinking" && (b.thinking ?? "").trim().length > 0);
		openaiField = !!first?.thinkingSignature && OPENAI_REASONING_FIELDS.includes(first.thinkingSignature);
	}
	for (const b of blocks) {
		if (b.type === "text") {
			if ((b.text ?? "").trim().length === 0) continue;
			text += textTokens(b.text ?? "");
			kept++;
		} else if (b.type === "toolCall") {
			tools += textTokens(`${b.name} ${JSON.stringify(b.arguments ?? {})}`) + 8;
			kept++;
		} else if (b.type === "thinking") {
			// transformMessages (Pi 1.4.0): thinking from another model is dropped, redacted or not.
			if (!sameModel) continue;
			const thinking = b.thinking ?? "";
			const signature = b.thinkingSignature;
			const signed = !!signature && signature.trim().length > 0;
			if (b.redacted) {
				// openai-completions has no redacted form; the others replay the opaque payload.
				if (api === "openai-completions") continue;
				// D4: anthropic-messages sends the block even without a payload; count when unsure.
				if (signed || api === "anthropic-messages") {
					reasoning += textTokens(signature ?? "");
					kept++;
				}
				continue;
			}
			if (thinking.trim().length === 0) {
				// D4: anthropic-messages sends same-model empty thinking that carries a signature.
				if (api === "anthropic-messages" && signed) {
					reasoning += textTokens(signature!);
					kept++;
				}
				continue;
			}
			if (api === "openai-completions") {
				if (target!.thinkingAsText) thinkingAsText += textTokens(thinking);
				else openaiThinking += textTokens(thinking);
				continue;
			}
			// anthropic-messages and bedrock: sent (as thinking when signed, else as text); reasoning either way.
			reasoning += textTokens(thinking);
			kept++;
		}
	}
	if (api === "openai-completions") {
		// Thinking goes as reasoning_details when they exist (counted at the larger of the details and the
		// thinking text: the details normally carry that text), else as the reasoning field its signature names.
		if (details > 0) reasoning += thinkingAsText > 0 ? details : Math.max(details, openaiThinking);
		else if (openaiField) reasoning += openaiThinking;
		// "Skip assistant messages that have no content and no tool calls" (openai-completions.ts).
		if (text === 0 && tools === 0 && thinkingAsText === 0) return { tokens: 0, reasoning: 0 };
		return {
			tokens: 4 + text + tools + reasoning + thinkingAsText,
			reasoning: reasoning + thinkingAsText,
			asText: thinkingAsText,
		};
	}
	if (kept === 0) return { tokens: 0, reasoning: 0 };
	return { tokens: 4 + text + tools + reasoning, reasoning };
}

export function installSerializer(core: EngineCore): void {
	const { st } = core;
	/** serializedParts for the current target, cached per message object. */
	function parts(message: AgentMessage): { tokens: number; reasoning: number; asText?: number } {
		let cache = st.serialCache.get(st.targetKey);
		if (!cache) {
			cache = new WeakMap();
			st.serialCache.set(st.targetKey, cache);
		}
		let value = cache.get(message);
		if (!value) {
			value = serializedParts(message, st.target);
			cache.set(message, value);
		}
		return value;
	}
	core.parts = parts;
	/**
	 * Budget tokens of a message: what Pi sends for the current model, the reasoning it replays included
	 * unless the model's replayedReasoning is "ignored" (thinking sent as text always counts).
	 */
	const sendTokens = (message: AgentMessage): number => {
		const p = parts(message);
		return st.replayIgnored ? p.tokens - (p.reasoning - (p.asText ?? 0)) : p.tokens;
	};
	core.sendTokens = sendTokens;
}
