/**
 * G1: real provider error wordings for output limits, context overflow and combined (input + output)
 * errors. `text` is the wording as found at `source` (numbers as found); `render` repeats the same
 * wording with the simulator's numbers for end-to-end runs. `verified: false` marks wordings that no
 * public source quoted verbatim (inferred, or attributed by a third party only).
 */
import type { ProviderErrorClass } from "./engine.ts";

export interface RenderValues {
	/** Output tokens the request asked for. */
	requested: number;
	/** The model's real output limit. */
	limit: number;
	/** Input tokens the provider counted. */
	input: number;
	/** The real context window. */
	context: number;
	model: string;
}

export interface ErrorFixture {
	id: string;
	provider: string;
	api: string;
	text: string;
	expected: { class: ProviderErrorClass; outputLimit?: number; input?: number; contextLimit?: number };
	render?: (v: RenderValues) => string;
	source: string;
	verified: boolean;
	note?: string;
}

const anthropicBody = (message: string) =>
	`400 {"type":"error","error":{"type":"invalid_request_error","message":"${message}"}}`;

export const ERROR_FIXTURES: ErrorFixture[] = [
	// ------------------------------------------------------------------ Anthropic direct
	{
		id: "anthropic-output-1",
		provider: "Anthropic direct",
		api: "messages",
		text: "max_tokens: 128001 > 128000, which is the maximum allowed number of output tokens for claude-opus-4-6",
		expected: { class: "output-limit", outputLimit: 128_000 },
		render: (v) =>
			anthropicBody(
				`max_tokens: ${v.requested} > ${v.limit}, which is the maximum allowed number of output tokens for ${v.model}`,
			),
		source: "https://github.com/anthropics/claude-code/issues/23923",
		verified: true,
	},
	{
		id: "anthropic-output-2",
		provider: "Anthropic direct",
		api: "messages",
		text: "max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens for claude-3-7-sonnet-20250219",
		expected: { class: "output-limit", outputLimit: 64_000 },
		source: "https://github.com/strands-agents/sdk-python/pull/1078 (review comment, Oct 31 2025)",
		verified: true,
	},
	{
		id: "anthropic-combined",
		provider: "Anthropic direct",
		api: "messages",
		text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 186433 + 20000 > 200000, decrease input length or `max_tokens` and try again"}}',
		expected: { class: "combined-output-caused", input: 186_433, contextLimit: 200_000 },
		render: (v) =>
			anthropicBody(
				`input length and \`max_tokens\` exceed context limit: ${v.input} + ${v.requested} > ${v.context}, decrease input length or \`max_tokens\` and try again`,
			),
		source:
			"https://github.com/anthropics/claude-code/issues/476 (tail 'and try again' from https://community.exploratory.io/t/4057)",
		verified: true,
	},
	{
		id: "anthropic-overflow",
		provider: "Anthropic direct",
		api: "messages",
		text: 'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 208310 tokens > 200000 maximum"},"request_id":"req_011CVQe1dLrGNMJyE1ghG1av"}',
		expected: { class: "context-overflow", input: 208_310, contextLimit: 200_000 },
		source: "https://github.com/anthropics/claude-code/issues/12186",
		verified: true,
	},
	// ------------------------------------------------------------------ Amazon Bedrock
	{
		id: "bedrock-converse-output",
		provider: "Bedrock",
		api: "Converse (Claude 3.5 Sonnet)",
		text: "ValidationException: The maximum tokens you requested exceeds the model limit of 4096. Try again with a maximum tokens value that is lower than 4096.",
		expected: { class: "output-limit", outputLimit: 4_096 },
		render: (v) =>
			`ValidationException: The maximum tokens you requested exceeds the model limit of ${v.limit}. Try again with a maximum tokens value that is lower than ${v.limit}.`,
		source: "https://github.com/vercel/ai/issues/2772",
		verified: true,
	},
	{
		id: "bedrock-invoke-overflow",
		provider: "Bedrock",
		api: "InvokeModel",
		text: "botocore.errorfactory.ValidationException: An error occurred (ValidationException) when calling the InvokeModel operation: Input is too long for requested model.",
		expected: { class: "context-overflow" },
		source:
			"https://repost.aws/questions/QUnNP6iMAnSIGym93PufUmFw/botocore-errorfactory-validationexception-an-error-occurred-validationexception-when-calling-the-invokemodel-operation-input-is-too-long-for-requested-model",
		verified: true,
	},
	{
		id: "bedrock-invoke-anthropic-combined",
		provider: "Bedrock",
		api: "InvokeModel (Anthropic body)",
		text: "ValidationException: input length and `max_tokens` exceed context limit: 195000 + 16384 > 200000, decrease input length or `max_tokens` and try again",
		expected: { class: "combined-output-caused", input: 195_000, contextLimit: 200_000 },
		render: (v) =>
			`ValidationException: input length and \`max_tokens\` exceed context limit: ${v.input} + ${v.requested} > ${v.context}, decrease input length or \`max_tokens\` and try again`,
		source: "none found: assumes Bedrock passes Anthropic's message through, as it does for other validation errors",
		verified: false,
	},
	{
		id: "bedrock-throttling",
		provider: "Bedrock",
		api: "Converse",
		text: "ThrottlingException: Too many tokens, please wait before trying again.",
		expected: { class: "unknown" },
		source: "Pi packages/ai/src/utils/overflow.ts (NON_OVERFLOW_PATTERNS comment); no public quote found",
		verified: false,
		note: "must not read as overflow ('too many tokens')",
	},
	// ------------------------------------------------------------------ Vertex AI
	{
		id: "vertex-anthropic-overflow-413",
		provider: "Vertex (Anthropic)",
		api: "rawPredict",
		text: 'API Error: 413 {"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Prompt is too long\\"}}","type":"None","param":"None","code":"413"}',
		expected: { class: "context-overflow" },
		source: "https://github.com/anthropics/claude-code/issues/2569",
		verified: true,
		note: "no numbers",
	},
	{
		id: "vertex-anthropic-output",
		provider: "Vertex (Anthropic)",
		api: "rawPredict",
		text: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 64001 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4@20250514"}}',
		expected: { class: "output-limit", outputLimit: 64_000 },
		render: (v) =>
			`{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: ${v.requested} > ${v.limit}, which is the maximum allowed number of output tokens for ${v.model}@20250514"}}`,
		source: "none found: assumes Vertex forwards Anthropic's error body (as it does for the 413 above)",
		verified: false,
	},
	{
		id: "gemini-output-range",
		provider: "Gemini (Vertex and Gemini API)",
		api: "generateContent",
		text: "Unable to submit request because it has a maxOutputTokens value of 828858 but the supported range is from 1 (inclusive) to 65537 (exclusive). Update the value and try again.",
		expected: { class: "output-limit", outputLimit: 65_536 },
		render: (v) =>
			`Unable to submit request because it has a maxOutputTokens value of ${v.requested} but the supported range is from 1 (inclusive) to ${v.limit + 1} (exclusive). Update the value and try again.`,
		source:
			"https://discuss.ai.google.dev/t/unable-to-submit-request-because-it-has-a-maxoutputtokens-value-of-828858/101543",
		verified: true,
	},
	{
		id: "gemini-overflow",
		provider: "Gemini (Vertex and Gemini API)",
		api: "generateContent",
		text: "The input token count (35868) exceeds the maximum number of tokens allowed (32768).",
		expected: { class: "context-overflow", input: 35_868, contextLimit: 32_768 },
		source:
			"https://discuss.ai.google.dev/t/help-with-error-the-input-token-count-35868-exceeds-the-maximum-number-of-tokens-allowed-32768/70784",
		verified: true,
	},
	// ------------------------------------------------------------------ OpenAI
	{
		id: "openai-chat-output",
		provider: "OpenAI",
		api: "chat completions (max_tokens)",
		text: "max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000",
		expected: { class: "output-limit", outputLimit: 16_384 },
		render: (v) =>
			`max_tokens is too large: ${v.requested}. This model supports at most ${v.limit} completion tokens, whereas you provided ${v.requested}.`,
		source: "https://community.openai.com/t/error-about-token-length-max-token/1151414",
		verified: true,
	},
	{
		id: "openai-chat-output-retryable-digits",
		provider: "OpenAI",
		api: "chat completions (max_tokens)",
		text: "max_tokens is too large: 15000. This model supports at most 4096 completion tokens, whereas you provided 15000.",
		expected: { class: "output-limit", outputLimit: 4_096 },
		render: () =>
			"max_tokens is too large: 15000. This model supports at most 4096 completion tokens, whereas you provided 15000.",
		source: "https://community.openai.com/t/problem-with-context-token-for-gpt-3-5-turbo-0125/823849",
		verified: true,
		note: "'15000' contains '500', which Pi's retry pattern treats as a 5xx: Pi retries it itself first",
	},
	{
		id: "openai-reasoning-output",
		provider: "OpenAI",
		api: "chat completions (max_completion_tokens, reasoning models)",
		text: "max_completion_tokens is too large: 200000. This model supports at most 100000 completion tokens, whereas you provided 200000.",
		expected: { class: "output-limit", outputLimit: 100_000 },
		render: (v) =>
			`max_completion_tokens is too large: ${v.requested}. This model supports at most ${v.limit} completion tokens, whereas you provided ${v.requested}.`,
		source: "none found verbatim: the max_tokens wording with the parameter renamed",
		verified: false,
	},
	{
		id: "openai-chat-combined",
		provider: "OpenAI",
		api: "chat completions",
		text: "[400] This model’s maximum context length is 16385 tokens. However, you requested 22114 tokens (7114 in the messages, 15000 in the completion). Please reduce the length of the messages or completion.",
		expected: { class: "combined-output-caused", input: 7_114, contextLimit: 16_385 },
		render: (v) =>
			`This model's maximum context length is ${v.context} tokens. However, you requested ${v.input + v.requested} tokens (${v.input} in the messages, ${v.requested} in the completion). Please reduce the length of the messages or completion.`,
		source: "https://community.openai.com/t/not-allowed-to-have-all-8192-tokens/321500",
		verified: true,
	},
	{
		id: "openai-legacy-combined",
		provider: "OpenAI",
		api: "legacy completions",
		text: "This model's maximum context length is 4097 tokens, however you requested 5360 tokens (1360 in your prompt; 4000 for the completion). Please reduce your prompt; or completion length.",
		expected: { class: "combined-output-caused", input: 1_360, contextLimit: 4_097 },
		source: "https://community.openai.com/t/annoying-error-if-max-completion-tokens-is-too-high/1111015",
		verified: true,
	},
	{
		id: "openai-chat-overflow",
		provider: "OpenAI",
		api: "chat completions",
		text: "400 This model's maximum context length is 4097 tokens. However, your messages resulted in 16727 tokens. Please reduce the length of the messages.",
		expected: { class: "context-overflow", input: 16_727, contextLimit: 4_097 },
		source:
			"https://community.openai.com/t/gpt-4-1106-preview-400-this-models-maximum-context-length-is-4097-tokens/578172",
		verified: true,
	},
	{
		id: "openai-responses-overflow",
		provider: "OpenAI",
		api: "Responses",
		text: "Your input exceeds the context window of this model. Please adjust your input and try again.",
		expected: { class: "context-overflow" },
		source: "https://github.com/openai/codex/issues/10823 (via the upd.dev mirror; code context_length_exceeded)",
		verified: true,
	},
	{
		id: "openai-responses-output",
		provider: "OpenAI",
		api: "Responses (max_output_tokens)",
		text: "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 128000, but got 200000 instead.",
		expected: { class: "output-limit", outputLimit: 128_000 },
		render: (v) =>
			`Invalid 'max_output_tokens': integer above maximum value. Expected a value <= ${v.limit}, but got ${v.requested} instead.`,
		source: "none found: OpenAI's generic integer-range validation wording, assumed for max_output_tokens",
		verified: false,
	},
	{
		id: "openai-unsupported-parameter",
		provider: "OpenAI",
		api: "chat completions (reasoning models)",
		text: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
		expected: { class: "unknown" },
		source: "https://github.com/simonw/llm/issues/724",
		verified: true,
		note: "a parameter-name error, not a limit",
	},
	{
		id: "deepseek-combined",
		provider: "DeepSeek (OpenAI-compatible)",
		api: "chat completions",
		text: "This model's maximum context length is 131072 tokens. However, you requested 131329 tokens (123137 in the messages, 8192 in the completion).",
		expected: { class: "combined-output-caused", input: 123_137, contextLimit: 131_072 },
		source: "https://github.com/musistudio/claude-code-router/issues/895",
		verified: true,
	},
	// ------------------------------------------------------------------ OpenRouter
	{
		id: "openrouter-combined-tool-input",
		provider: "OpenRouter",
		api: "chat completions",
		text: "Internal error: 400 This endpoint’s maximum context length is 131072 tokens. However, you requested about 135349 tokens (60662 of text input, 10687 of tool input, 64000 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.",
		expected: { class: "combined-output-caused", input: 71_349, contextLimit: 131_072 },
		render: (v) =>
			`This endpoint's maximum context length is ${v.context} tokens. However, you requested about ${v.input + v.requested} tokens (${v.input - 500} of text input, 500 of tool input, ${v.requested} in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.`,
		source: "https://github.com/QwenLM/qwen-code/issues/5950",
		verified: true,
	},
	{
		id: "openrouter-combined-text-only",
		provider: "OpenRouter",
		api: "chat completions",
		text: 'This endpoint\'s maximum context length is 131072 tokens. However, you requested about 138956 tokens (7884 of text input, 131072 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.',
		expected: { class: "combined-output-caused", input: 7_884, contextLimit: 131_072 },
		render: (v) =>
			`This endpoint's maximum context length is ${v.context} tokens. However, you requested about ${v.input + v.requested} tokens (${v.input} of text input, ${v.requested} in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.`,
		source: "https://github.com/OpenHands/OpenHands/issues/9937",
		verified: true,
	},
	{
		id: "openrouter-combined-input-too-long",
		provider: "OpenRouter",
		api: "chat completions",
		text: 'This endpoint\'s maximum context length is 200000 tokens. However, you requested about 5028244 tokens (4945291 of text input, 2953 of tool input, 80000 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.',
		expected: { class: "context-overflow", input: 4_948_244, contextLimit: 200_000 },
		source: "https://github.com/agno-agi/agno/issues/3980",
		verified: true,
		note: "combined wording, but the input alone does not fit: a real overflow",
	},
	// ------------------------------------------------------------------ vLLM / OpenAI-compatible servers
	{
		id: "vllm-max-tokens-too-large",
		provider: "vLLM >= 0.10",
		api: "OpenAI-compatible",
		text: "ValueError: 'max_tokens' or 'max_completion_tokens' is too large: 21333. This model's maximum context length is 196608 tokens and your request has 175808 input tokens (21333 > 196608 - 175808).",
		expected: { class: "combined-output-caused", input: 175_808, contextLimit: 196_608 },
		render: (v) =>
			`'max_tokens' or 'max_completion_tokens' is too large: ${v.requested}. This model's maximum context length is ${v.context} tokens and your request has ${v.input} input tokens (${v.requested} > ${v.context} - ${v.input}).`,
		source:
			"https://discuss.vllm.ai/t/topic/2075 and vllm v0.11.0 vllm/entrypoints/openai/serving_engine.py (_validate_input)",
		verified: true,
	},
	{
		id: "vllm-old-combined",
		provider: "vLLM <= 0.8",
		api: "OpenAI-compatible",
		text: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (5000 in the messages, 4000 in the completion). Please reduce the length of the messages or completion.",
		expected: { class: "combined-output-caused", input: 5_000, contextLimit: 8_192 },
		source: "vllm v0.8.5 vllm/entrypoints/openai/serving_engine.py (_validate_input template; numbers illustrative)",
		verified: true,
	},
	{
		id: "vllm-overflow",
		provider: "vLLM >= 0.10",
		api: "OpenAI-compatible",
		text: "This model's maximum context length is 8192 tokens. However, your request has 9000 input tokens. Please reduce the length of the input messages.",
		expected: { class: "context-overflow", input: 9_000, contextLimit: 8_192 },
		source: "vllm v0.11.0 vllm/entrypoints/openai/serving_engine.py (_validate_input template; numbers illustrative)",
		verified: true,
	},
	{
		id: "tgi-combined",
		provider: "Hugging Face TGI",
		api: "generate / chat",
		text: "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8192. Given: 6391 `inputs` tokens and 2047 `max_new_tokens`",
		expected: { class: "combined-output-caused", input: 6_391, contextLimit: 8_192 },
		render: (v) =>
			`Input validation error: \`inputs\` tokens + \`max_new_tokens\` must be <= ${v.context}. Given: ${v.input} \`inputs\` tokens and ${v.requested} \`max_new_tokens\``,
		source: "https://huggingface.co/spaces/huggingchat/chat-ui/discussions/430",
		verified: true,
	},
	{
		id: "tgi-overflow",
		provider: "Hugging Face TGI",
		api: "generate / chat",
		text: "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 131072. Given: 227472 `inputs` tokens and 0 `max_new_tokens`",
		expected: { class: "context-overflow", input: 227_472, contextLimit: 131_072 },
		source: "https://huggingface.co/spaces/huggingchat/chat-ui/discussions/430",
		verified: true,
	},
	{
		id: "scaleway-output",
		provider: "Scaleway Generative APIs (OpenAI-compatible)",
		api: "chat completions",
		text: "416: Range Not Satisfiable - max_completion_tokens is limited for this model",
		expected: { class: "output-limit" },
		render: () => "416: Range Not Satisfiable - max_completion_tokens is limited for this model",
		source: "https://www.scaleway.com/en/docs/generative-apis/troubleshooting/fixing-common-issues/",
		verified: true,
		note: "no number: the engine steps down",
	},
	{
		id: "generic-output-no-number",
		provider: "Anthropic (as normalized by Portkey)",
		api: "messages",
		text: "Max tokens exceed the allowable limit for the model. Reduce the number of tokens to comply with the model's constraints.",
		expected: { class: "output-limit" },
		render: () =>
			"Max tokens exceed the allowable limit for the model. Reduce the number of tokens to comply with the model's constraints.",
		source:
			"https://portkey.ai/error-library/input-limit-exceeded-error-10156 (Portkey's paraphrase, not the provider's text)",
		verified: false,
		note: "no number: the engine steps down",
	},
	{
		id: "groq-tpm",
		provider: "Groq",
		api: "chat completions",
		text: "Request too large for model `llama-3.1-8b-instant` in organization `xxxx` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 6294, please reduce your message size and try again.",
		expected: { class: "unknown" },
		source: "https://github.com/elizaOS/eliza/issues/4040",
		verified: true,
		note: "a rate limit with 'Limit' and 'Requested': must not read as overflow or output limit",
	},
	// ------------------------------------------------------------------ z.ai / GLM
	{
		id: "zai-overflow",
		provider: "z.ai (GLM)",
		api: "chat completions",
		text: '{"code":"1261","message":"Prompt too long"}',
		expected: { class: "context-overflow" },
		source:
			"https://docs.z.ai/api-reference/api-code (row: 1261 | 400 | Prompt too long); JSON shape from Pi's overflow.ts",
		verified: true,
	},
	{
		id: "zai-cn-overflow",
		provider: "z.ai (GLM, CN endpoint)",
		api: "chat completions",
		text: '{"code":"1261","message":"Prompt exceeds max length"}',
		expected: { class: "context-overflow" },
		source: "Pi packages/ai/src/utils/overflow.ts comment only",
		verified: false,
	},
	{
		id: "glm-overflow-numbers",
		provider: "GLM-5.x (provider not named)",
		api: "chat completions",
		text: "The prompt is too long: 207601, model maximum context length: 202751",
		expected: { class: "context-overflow", input: 207_601, contextLimit: 202_751 },
		source:
			"https://docs.openwebui.com/troubleshooting/context-window (wording quoted; the page does not name the provider)",
		verified: false,
		note: "wording verified, attribution to GLM inferred",
	},
];
