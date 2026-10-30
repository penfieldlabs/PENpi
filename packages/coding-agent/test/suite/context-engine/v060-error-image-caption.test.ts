/**
 * 0.6.0 (Pi 1.4.0, splitErrorToolResultImages): anthropic-messages, and bedrock-converse-stream for a Claude model,
 * send an error tool result with images as text with one placeholder line per run of images, and the images after
 * the turn's tool results under a caption naming the call. The estimate counts the placeholders and the caption.
 */
import { describe, expect, it } from "vitest";
import { serializedParts, textTokens } from "./engine.ts";

const PLACEHOLDER = "(image attached after the tool results)";
const IMAGE = { type: "image", data: "aGVsbG8gd29ybGQ=", mimeType: "image/png" };

const result = (isError: boolean) =>
	({
		role: "toolResult",
		toolCallId: "call-7",
		toolName: "screenshot",
		isError,
		content: [{ type: "text", text: "Render failed:" }, IMAGE, IMAGE, { type: "text", text: "and again:" }, IMAGE],
		timestamp: 0,
	}) as never;

const target = (api: string, modelId: string) => ({ api, provider: "p", modelId, thinkingAsText: false });

describe("0.6.0: error tool results with images", () => {
	const extra =
		2 * textTokens(PLACEHOLDER) + textTokens("Images from the error result of tool call call-7 (screenshot):");

	it("v060 anthropic-messages and Claude on Bedrock count a placeholder per run of images and the caption", () => {
		for (const t of [
			target("anthropic-messages", "claude-sonnet-5-5"),
			target("bedrock-converse-stream", "anthropic.claude-sonnet-5-5"),
		]) {
			expect(serializedParts(result(true), t).tokens - serializedParts(result(false), t).tokens).toBe(extra);
		}
	});

	it("v060 other targets, and a result that is not an error, count the result as before", () => {
		for (const t of [
			target("bedrock-converse-stream", "amazon.nova-pro-v1:0"),
			target("openai-completions", "glm-5.3"),
		]) {
			expect(serializedParts(result(true), t).tokens).toBe(serializedParts(result(false), t).tokens);
		}
		const anthropic = target("anthropic-messages", "claude-sonnet-5-5");
		expect(serializedParts(result(false), anthropic).tokens).toBe(serializedParts(result(false)).tokens);
	});
});
