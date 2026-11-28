/**
 * How a model's chat template renders the reasoning Pi replays (0.9.0, design section 5). Pi's converter sends earlier
 * turns' reasoning; many templates render it only after some boundary, so at that boundary it leaves the prompt and the
 * reported growth falls short of the exact delta by that much. A rule belongs to a model, not to a tokenizer file.
 *
 * - "drop": reasoning renders only for assistant turns after the last user message.
 * - "keep": every turn's reasoning renders.
 * - "none": the template renders no reasoning; a session that has some anyway is judged on the fallback rules.
 * - "after-final": reasoning renders only for assistant turns after the last final answer (the last assistant message
 *   without tool calls).
 * - "after-final-text": as "after-final", and a tool-call turn's assistant text goes with its reasoning (gpt-oss).
 * - undefined (not pinned): an append crossing a user message after reasoning-bearing turns is a fallback sample.
 *
 * Each rule is pinned per catalogue id pattern, with the templates it was read from: the repo, the full revision, the
 * file holding the template (chat_template.jinja, or tokenizer_config.json's chat_template) and the template's SHA-256.
 * reasoning-rules.test.ts renders each template, fetched and checked by `npm run setup:tokenizers`, on a Pi-shaped
 * conversation (tools, tool-call turns, a final answer, a second user message) and checks that it gives its rule.
 * Conditional templates are pinned as Pi drives them: Pi always sends tools, so DeepSeek V4.1-Flash keeps
 * (`effective_drop = drop_thinking and not has_tools`); Qwen 3.6 and Gemma 4 drop, since Pi never sets
 * `preserve_thinking`. DeepSeek V4 and V3.2 have no template in their repos: they are pinned from the encoding code
 * the repos ship instead, named in each rule's note, with no template to render.
 *
 * Not pinned, so fallback samples on such an append: GPT-5, the o-series and Codex (Pi replays reasoning items that
 * OpenAI bills by its own rules); DeepSeek V3.2-Exp; Kimi K3 and K3.1 (no template in their repos); Mistral Nemo
 * and Mixtral (their templates refuse tool turns); MiniMax M1; API-only names, which are assumed names anyway.
 */

export type ReasoningRule = "drop" | "keep" | "none" | "after-final" | "after-final-text";

/** A chat template a rule was read from. */
export interface RuleTemplate {
	repo: string;
	/** The full commit. */
	revision: string;
	file: "chat_template.jinja" | "tokenizer_config.json";
	/** SHA-256 of the template's text (UTF-8), however the file holds it. */
	sha256: string;
}

/**
 * What a model's template renders around tool calls beyond its entry's tokens a message (detector.ts exactTolerance):
 * per call, and per argument. Measured by rendering Pi-shaped appends (tool calls of one to three arguments, two calls in
 * one turn) with each of the rule's templates and counting them with the model's tokenizer, against the engine's exact
 * count of the same messages; the largest, plus 2. A rule without it has its template within the entry's tolerance.
 */
export interface TemplateTokens {
	call: number;
	argument: number;
}

export interface PinnedRule {
	rule: ReasoningRule;
	/** Lower-cased catalogue id patterns. */
	ids: RegExp;
	/** Catalogue ids the rule must place (the family test checks the first match is this rule). */
	examples: string[];
	templates: RuleTemplate[];
	templateTokens?: TemplateTokens;
	note?: string;
}

/** The order matters: the first match wins, so a generation comes before its family. */
export const REASONING_RULES: PinnedRule[] = [
	{
		rule: "drop",
		ids: /qwen3-235b-a22b-thinking-2507/,
		examples: ["qwen/qwen3-235b-a22b-thinking-2507"],
		templates: [
			{
				repo: "Qwen/Qwen3-235B-A22B-Thinking-2507",
				revision: "6cbffae6d8e28b986a6b17bd36f42f9fa0f1f0a5",
				file: "tokenizer_config.json",
				sha256: "3802169b2a02b81e6adb7ab4f64f91ff02db753c8c3a64a01c35192d3a61d8d7",
			},
		],
		templateTokens: { call: 6, argument: 3 },
		note: "last_query_index",
	},
	{
		rule: "drop",
		ids: /qwen3-vl-235b-a22b-thinking/,
		examples: ["qwen/qwen3-vl-235b-a22b-thinking"],
		templates: [
			{
				repo: "Qwen/Qwen3-VL-235B-A22B-Thinking",
				revision: "6664affde68449468deb7527186455c7450c13c0",
				file: "tokenizer_config.json",
				sha256: "36e042fe45641f067b1f2381fcc8955d10d956a3ed333ecdf7f7eb0916f68956",
			},
		],
		templateTokens: { call: 6, argument: 3 },
	},
	{
		rule: "none",
		ids: /qwen-?3-coder|qwen-?3-vl-\d+b-instruct|qwen-?3-vl-instruct|qwen-?2\.5/,
		examples: ["qwen/qwen3-coder", "qwen/qwen3-vl-8b-instruct", "qwen/qwen-2.5-7b-instruct"],
		templates: [
			{
				repo: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
				revision: "b2cff646eb4bb1d68355c01b18ae02e7cf42d120",
				file: "chat_template.jinja",
				sha256: "5a38bfa05833266240066aedc497decc9b00cc0d3e3b8cceea98cf530196ab06",
			},
			{
				repo: "Qwen/Qwen3-VL-8B-Instruct",
				revision: "0c351dd01ed87e9c1b53cbc748cba10e6187ff3b",
				file: "tokenizer_config.json",
				sha256: "3636d0f0bd6bef02654cdffdc447b79cb2cef8ab02cc75267345946291a489e4",
			},
			{
				repo: "Qwen/Qwen2.5-7B-Instruct",
				revision: "a09a35458c702b33eeacc393d103063234e8bc28",
				file: "tokenizer_config.json",
				sha256: "cd8e9439f0570856fd70470bf8889ebd8b5d1107207f67a5efb46e342330527f",
			},
		],
		templateTokens: { call: 2, argument: 14 },
	},
	{
		rule: "drop",
		ids: /qwen-?3\.6/,
		examples: ["qwen/qwen3.6-27b", "alibaba/qwen3.6-35b-a3b"],
		templates: [
			{
				repo: "Qwen/Qwen3.6-27B",
				revision: "1cda14dd71a3f47115850eb790f416f165da1cb5",
				file: "chat_template.jinja",
				sha256: "1b8361565cc35d47551d342214cff341c0f1a9685ce529c7ce31de0ed3616248",
			},
		],
		templateTokens: { call: 3, argument: 11 },
		note: "drops unless preserve_thinking, which Pi never sets",
	},
	{
		rule: "keep",
		ids: /qwen-?3[.p]8/,
		examples: ["qwen/qwen3.8-27b", "alibaba/qwen3.8-2.4t-a95b"],
		templates: [
			{
				repo: "Qwen/Qwen3.8-27B",
				revision: "37561816e66b5b9153b1b64c10968c18c1e6f4a0",
				file: "chat_template.jinja",
				sha256: "af16f654968d47d09a6c604e00370b12dbc21f76456f59c9e98b82e84d9f6375",
			},
		],
		templateTokens: { call: 3, argument: 11 },
		note: "preserve_thinking undefined keeps",
	},
	{
		rule: "drop",
		ids: /qwen-?3\.5/,
		examples: ["qwen/qwen3.5-27b", "qwen/qwen3.5-9b", "qwen/qwen3.5-397b-a17b"],
		templates: [
			{
				repo: "Qwen/Qwen3.5-0.8B",
				revision: "2fc06364715b967f1860aea9cf38778875588b17",
				file: "chat_template.jinja",
				sha256: "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80",
			},
			{
				repo: "Qwen/Qwen3.5-2B",
				revision: "15852e8c16360a2fea060d615a32b45270f8a8fc",
				file: "chat_template.jinja",
				sha256: "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80",
			},
			{
				repo: "Qwen/Qwen3.5-4B",
				revision: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
				file: "chat_template.jinja",
				sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
			},
			{
				repo: "Qwen/Qwen3.5-9B",
				revision: "c202236235762e1c871ad0ccb60c8ee5ba337b9a",
				file: "chat_template.jinja",
				sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
			},
			{
				repo: "Qwen/Qwen3.5-27B",
				revision: "81a287ca484a5e71148f5beb7f367bb5286d70f9",
				file: "chat_template.jinja",
				sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
			},
			{
				repo: "Qwen/Qwen3.5-35B-A3B",
				revision: "2508b2437e382c605eb0fc52b83f5545960f6b4a",
				file: "chat_template.jinja",
				sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
			},
			{
				repo: "Qwen/Qwen3.5-122B-A10B",
				revision: "dc4d348443bc740c68e2d77492492c11606384d5",
				file: "chat_template.jinja",
				sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
			},
			{
				repo: "Qwen/Qwen3.5-397B-A17B",
				revision: "8472618112abcbd45acbcdc58436aff4233c23f7",
				file: "chat_template.jinja",
				sha256: "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
			},
		],
		templateTokens: { call: 3, argument: 11 },
		note: "every size",
	},
	{
		rule: "drop",
		ids: /(^|[/.])qwen3-(8b|14b|30b-a3b|32b|235b-a22b)(?![-\w])/,
		examples: ["qwen/qwen3-32b", "qwen/qwen3-30b-a3b"],
		templates: [
			{
				repo: "Qwen/Qwen3-32B",
				revision: "9216db5781bf21249d130ec9da846c4624c16137",
				file: "tokenizer_config.json",
				sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
			},
		],
		templateTokens: { call: 6, argument: 3 },
		note: "the hybrid Qwen 3 sizes, last_query_index",
	},
	{
		rule: "keep",
		ids: /glm-?5[.p]3/,
		examples: ["glm-5.3", "glm-5.3-flash", "accounts/fireworks/models/glm-5p3"],
		templates: [
			{
				repo: "zai-org/GLM-5.3",
				revision: "ba32f8c19c8738e2c57c71798c601d477a7bf844",
				file: "chat_template.jinja",
				sha256: "0e2b6268ac54f04d2bc1157e8cfb896cb66f25c0b5e319ea12e56014c3914f24",
			},
			{
				repo: "zai-org/GLM-5.3-Flash",
				revision: "46a050bec13002ad29ee795c16e61cf4fa3c4a9c",
				file: "chat_template.jinja",
				sha256: "2614a3c896d53e265f564c23701173c0049f985dacfbae79fc4bcd9f5ba083f4",
			},
		],
		note: "clear_thinking defaults to false",
	},
	{
		rule: "drop",
		ids: /glm-5(\.[12]|-2)?(?![.\dp])/,
		examples: ["glm-5", "glm-5.1", "glm-5.2", "z-ai/glm-5"],
		templates: [
			{
				repo: "zai-org/GLM-5",
				revision: "c183ef8c61faee82855eca1ed9bb3a9a7ce3b0b2",
				file: "chat_template.jinja",
				sha256: "45a1d5635afd3d8e08a28866e72fc8395d2a7ec30989fd0bdaec6dd45a99eff0",
			},
			{
				repo: "zai-org/GLM-5.1",
				revision: "26e1bd6e011feb778d25ae34b09b07074139d92d",
				file: "chat_template.jinja",
				sha256: "03b1bbff20331e54647c68167e8ac7f0b5b7ceb40ead372f44826624a9ad79cd",
			},
			{
				repo: "zai-org/GLM-5.2",
				revision: "cf457fa734ab149ffef225f80893eb38c6ff5cdc",
				file: "chat_template.jinja",
				sha256: "172dc74a35e1752df75ecfb2b2cf9326d2852bb1379868ebeec9571654489679",
			},
		],
		note: "at the last user message",
	},
	{
		rule: "drop",
		ids: /(^|[/.])glm-4\.7(?!-flash)/,
		examples: ["z-ai/glm-4.7", "glm-4.7"],
		templates: [
			{
				repo: "zai-org/GLM-4.7",
				revision: "602d01efcdd332c5238ca4bcede555defbe83eb7",
				file: "chat_template.jinja",
				sha256: "d63ad536c3c81880043e22ec7fd08db42b4d8fb7c89c7138bc562bfa25281375",
			},
		],
		note: "clear_thinking undefined",
	},
	{
		rule: "keep",
		ids: /mimo-v2\.[56]/,
		examples: ["xiaomi/mimo-v2.6-pro", "mimo-v2.6-pro"],
		templates: [
			{
				repo: "XiaomiMiMo/MiMo-V2.5",
				revision: "d6bf9db68673d1f903a53d8da417b293fdc97d1f",
				file: "tokenizer_config.json",
				sha256: "3134ac101acd29d3ab41297707cc1a85699f5f0acb283fdeb0681e3750998403",
			},
			{
				repo: "XiaomiMiMo/MiMo-V2.5-Pro",
				revision: "98e90df48208087a2eb974866a736a20f8122d2a",
				file: "tokenizer_config.json",
				sha256: "bafea0fe0bd53ef1156649859ca6eeec812ef1d95a62d08323841f2431067cc2",
			},
			{
				repo: "XiaomiMiMo/MiMo-V2.6-Pro-RL",
				revision: "a066ba0057192126bd5d255f37138265fc1a435e",
				file: "chat_template.jinja",
				sha256: "11ea52e156de38a458e6b7720ad45915d65b97d4ec979a09f55e3c9bd1b4d059",
			},
		],
		templateTokens: { call: 2, argument: 12 },
		note: "keep_all_reasoning defaults to true",
	},
	{
		rule: "drop",
		ids: /minimax-m2(\.[157])?(?![.\d])/,
		examples: ["minimax/minimax-m2.1", "minimax/minimax-m2.5", "minimax/minimax-m2.7"],
		templates: [
			{
				repo: "MiniMaxAI/MiniMax-M2",
				revision: "2a6104622dd83ee7e424e7d218736021a56745bd",
				file: "chat_template.jinja",
				sha256: "86cd6e574dec52bf6d7e678c5b46ceb5223d68b3a1130bbbc09d0a2dc0909438",
			},
			{
				repo: "MiniMaxAI/MiniMax-M2.1",
				revision: "369ab97103ad5fa93f79081d1733529520d408fa",
				file: "chat_template.jinja",
				sha256: "2aeb48049bf0f720e16706cf98309b534ca277cda04887da961866c6f1e108ae",
			},
			{
				repo: "MiniMaxAI/MiniMax-M2.5",
				revision: "36f171c15db66576b4b40a4011eb77fe9ac770c2",
				file: "chat_template.jinja",
				sha256: "f83cec52bb3a7e5a3cb4d6fd1dfdd6f4fe13b06c5aaa39a1115e70a417fc75f5",
			},
			{
				repo: "MiniMaxAI/MiniMax-M2.7",
				revision: "0a6536713b0b03f3be97494e5cf8d22f668a3164",
				file: "chat_template.jinja",
				sha256: "893d908f7b5cc65fdde270dcae5ea1a99647c6a7ce572ae874a57b7160069566",
			},
		],
		templateTokens: { call: 2, argument: 13 },
	},
	{
		rule: "keep",
		ids: /ling-3\.1-flash-1019/,
		examples: ["inclusionai/ling-3.1-flash-1019"],
		templates: [
			{
				repo: "inclusionAI/Ling-3.1-flash-1019",
				revision: "2109a6863fb14361eecc346ef98b3db88b8cdaee",
				file: "chat_template.jinja",
				sha256: "f9beb6cdd406923de4999458056f2cccd016f348ccfa588c0bdb82ee0dbce457",
			},
		],
		note: "preserved_thinking",
	},
	{
		rule: "drop",
		ids: /ling-2\.6-flash/,
		examples: ["inclusionai/ling-2.6-flash"],
		templates: [
			{
				repo: "inclusionAI/Ling-2.6-flash",
				revision: "89f8441a870241ea8c36959b629393045d565e0e",
				file: "chat_template.jinja",
				sha256: "0e5b40c170f3630634d1f9023ee19d0d28dba2e02bc46354122b1774688cd8d8",
			},
		],
		templateTokens: { call: 8, argument: 2 },
		note: "last_query_index",
	},
	{
		rule: "drop",
		ids: /nemotron-3(\.5)?-(super|nano|ultra|lightning)|nemotron-(super|nano)-3/,
		examples: ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b"],
		templates: [
			{
				repo: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
				revision: "2dc98e2afe4face0e4ce40972a915c45368bd34a",
				file: "chat_template.jinja",
				sha256: "575fb74f54ed264df9047d0ecce3c98938aae953fb4f50356675706264cbb68a",
			},
			{
				repo: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
				revision: "bf77c3174f68ad409e1c2aa60daeb46e32d1c606",
				file: "chat_template.jinja",
				sha256: "ab7813c3abdd9cb655905a410728b26c7884eca45ddfab8d9f931553485a7862",
			},
			{
				repo: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16",
				revision: "fb0ee0bc6b3f70342afd8d84cb80dbadbaa8a1fe",
				file: "chat_template.jinja",
				sha256: "1369e90b19976f99ce2070eb21ade8fcb4af640f008e14e82af5c5e89a9cc816",
			},
			{
				repo: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16",
				revision: "77df655d5e9f8362164ed14dd8b48f8bce657498",
				file: "chat_template.jinja",
				sha256: "82753bef5cedc4932c1ed509b5c9a12be680fd86d1adb65bc3f7398d11c8eebc",
			},
			{
				repo: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
				revision: "a9904d24bcc1d289a1950fa9d2b978c47cf903b9",
				file: "chat_template.jinja",
				sha256: "58933db77d3099b4f78c55a38347a72e1ea05b97d6bd8f38775303dc0194e0a9",
			},
		],
		templateTokens: { call: 2, argument: 13 },
		note: "truncate_history_thinking defaults to true",
	},
	{
		rule: "keep",
		ids: /deepseek-v4[.p-]1-flash/,
		examples: ["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash"],
		templates: [
			{
				repo: "deepseek-ai/DeepSeek-V4.1-Flash",
				revision: "314113f8a7dadb388215396ba5fbee2c610a04d6",
				file: "chat_template.jinja",
				sha256: "d959d804d5101b79a49b6ff1bf3c54cd5affa9a5a78c503d925f3090040b31c3",
			},
		],
		templateTokens: { call: 2, argument: 18 },
		note: "keeps with tools, which Pi always sends",
	},
	{
		rule: "keep",
		ids: /deepseek-v4/,
		examples: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "deepseek-v4-pro-0813"],
		templates: [],
		templateTokens: { call: 2, argument: 18 },
		note:
			"no template: encoding/encoding_dsv4.py in deepseek-ai/DeepSeek-V4-Pro at b5968e9190ef611bbf34a7229255be88a0e937c1 " +
			"keeps every turn's reasoning when tools are sent (effective_drop_thinking is false with tools), as DeepSeek's API docs say; " +
			"the template terms are V4.1 Flash's measure, since encoding_dsv4.py renders the same DSML lines per call and argument",
	},
	{
		rule: "drop",
		ids: /deepseek(-|\.)v3\.2(?!-exp)/,
		examples: ["deepseek/deepseek-v3.2", "deepseek.v3.2", "deepseek/deepseek-v3.2-thinking"],
		templates: [],
		note:
			"no template: encoding/encoding_dsv32.py in deepseek-ai/DeepSeek-V3.2 at a7e62ac04ecb2c0a54d736dc46601c5606cf10a6 " +
			"renders an assistant turn's reasoning only after the last user message, with tools or without, as its test fixture shows",
	},
	{
		rule: "none",
		ids: /deepseek-r1|deepseek(-chat)?-v3(\.1|-0324)?(?![.\d])/,
		examples: ["deepseek/deepseek-r1", "deepseek/deepseek-v3.1", "deepseek/deepseek-chat-v3.1"],
		templates: [
			{
				repo: "deepseek-ai/DeepSeek-V3-0324",
				revision: "e9b33add76883f293d6bf61f6bd89b497e80e335",
				file: "tokenizer_config.json",
				sha256: "22e97ba043dacf9df1f071a9de9d2bb6b0757491f16e96e810834b86e1641286",
			},
			{
				repo: "deepseek-ai/DeepSeek-R1-0528",
				revision: "4236a6af538feda4548eca9ab308586007567f52",
				file: "tokenizer_config.json",
				sha256: "53671bac29bcb3e1f95f51b8c77d85a6011b66dc38bd23dce64eef04384a976b",
			},
			{
				repo: "deepseek-ai/DeepSeek-V3.1",
				revision: "c0781d039fb7a1ba2abc4add0bdc293e92d2b8db",
				file: "tokenizer_config.json",
				sha256: "45690185067ea25c073bff2d3e425a45ee2564d2bbf6cdf7d885e139d460b8e0",
			},
		],
		note: "earlier reasoning is never rendered",
	},
	{
		rule: "after-final",
		ids: /kimi-k2-thinking|kimi-k2\.[56]/,
		examples: ["moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2.6"],
		templates: [
			{
				repo: "moonshotai/Kimi-K2-Thinking",
				revision: "a51ccc050d73dab088bf7b0e2dd9b30ae85a4e55",
				file: "chat_template.jinja",
				sha256: "07a791b8563c5159054394745049c8e487986ecb34aaab77727e1b158bbe6a5c",
			},
			{
				repo: "moonshotai/Kimi-K2.5",
				revision: "94b44e57fb4797fde1c1872bed70aef3c93a07f6",
				file: "chat_template.jinja",
				sha256: "7c91e4b3578b518bfb388d2e3dc645daf0fbf843656e887db75d12891e0030ff",
			},
			{
				repo: "moonshotai/Kimi-K2.6",
				revision: "7eb5002f6aadc958aed6a9177b7ed26bb94011bb",
				file: "chat_template.jinja",
				sha256: "8bf859698fd4781c0e1e1c63ce74422aab27e53ccc5f47116317c64cda06132f",
			},
		],
		templateTokens: { call: 2, argument: 2 },
		note: "reasoning after the last final answer",
	},
	{
		rule: "none",
		ids: /kimi-k2-instruct|kimi-k2-0905/,
		examples: ["moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-0905"],
		templates: [
			{
				repo: "moonshotai/Kimi-K2-Instruct",
				revision: "fd1984e2b7a3350dbf7305fe73a4ede25c14de50",
				file: "chat_template.jinja",
				sha256: "39e8c195b474c1a4148046f41fedd177b2ff8f420fa376e52fcdddb829e8f0c5",
			},
		],
	},
	{
		rule: "drop",
		ids: /gemma-4/,
		examples: ["google/gemma-4-31b-it", "google/gemma-4-26b-a4b-it", "google.gemma-4-e2b"],
		templates: [
			{
				repo: "google/gemma-4-31B-it",
				revision: "842da3794eaa0b77d5f08bae87a17459d91ff475",
				file: "chat_template.jinja",
				sha256: "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4",
			},
			{
				repo: "google/gemma-4-26B-A4B-it",
				revision: "4d7ae4984b7db7de8f8457170b3f1a419ee76d52",
				file: "chat_template.jinja",
				sha256: "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4",
			},
			{
				repo: "google/gemma-4-E2B-it",
				revision: "4adf15748de9e1a0097b6274cee9c15836c41c37",
				file: "chat_template.jinja",
				sha256: "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5",
			},
			{
				repo: "google/gemma-4-12B-it",
				revision: "43c9d014b231474fa7212dbb48a762566c2b255d",
				file: "chat_template.jinja",
				sha256: "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4",
			},
		],
		note: "before the last user message; Pi never sets preserve_thinking",
	},
	{
		rule: "keep",
		ids: /inkling/,
		examples: ["thinkingmachines/inkling", "thinkingmachines/inkling-2-small"],
		templates: [
			{
				repo: "thinkingmachines/Inkling",
				revision: "828496eeae4c243ff1a22f7f28ff83694f2f7bc9",
				file: "chat_template.jinja",
				sha256: "0aa1aa0c729d90176dcaa00c440c8faffca2957ffb2cc4b79456ee6d02bcf43b",
			},
			{
				repo: "thinkingmachines/Inkling-2-Small",
				revision: "885d78bfca61a7e9a498e33cfa7ad35850533b8c",
				file: "chat_template.jinja",
				sha256: "53a9035f3255945704b5857657cfb00c1165090c0641c4f782a0cbf268cc16dc",
			},
		],
		templateTokens: { call: 5, argument: 1 },
	},
	{
		rule: "after-final-text",
		ids: /gpt-oss/,
		examples: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
		templates: [
			{
				repo: "openai/gpt-oss-120b",
				revision: "b5c939de8f754692c1647ca79fbf85e8c1e70f8a",
				file: "chat_template.jinja",
				sha256: "a4c9919cbbd4acdd51ccffe22da049264b1b73e59055fa58811a99efbd7c8146",
			},
			{
				repo: "openai/gpt-oss-20b",
				revision: "6cee5e81ee83917806bbde320786a8fb61efebee",
				file: "chat_template.jinja",
				sha256: "a4c9919cbbd4acdd51ccffe22da049264b1b73e59055fa58811a99efbd7c8146",
			},
		],
		templateTokens: { call: 49, argument: 5 },
		note: "drops a tool-call turn's analysis, its text, once a later final message exists",
	},
	{
		rule: "keep",
		ids: /mistral-large-3|mistral-large-2512/,
		examples: ["mistral/mistral-large-3", "mistralai/mistral-large-2512"],
		templates: [
			{
				repo: "mistralai/Mistral-Large-3-675B-Instruct-2512",
				revision: "51330c9da67945183568346369a07be224e5e1b0",
				file: "chat_template.jinja",
				sha256: "5a116e675b45579704c7e77a4aff62cf587862f87efe84584e5e2ba1d49c0ac0",
			},
		],
	},
	{
		rule: "none",
		ids: /ministral|devstral-2|devstral-small-2|labs-devstral/,
		examples: ["mistralai/ministral-8b-2512", "mistralai/devstral-2512"],
		templates: [
			{
				repo: "mistralai/Ministral-3-8B-Instruct-2512",
				revision: "d2ff65a33fc5f72d77a65a2bc366feefd44ca320",
				file: "chat_template.jinja",
				sha256: "338c134a61cf54e1d250a8f6c2e974c788c14ae97dd6e7b2491d5446ec472490",
			},
		],
	},
	{
		rule: "none",
		ids: /mistral-small-3\.1/,
		examples: ["mistralai/mistral-small-3.1-24b-instruct"],
		templates: [
			{
				repo: "mistralai/Mistral-Small-3.1-24B-Instruct-2503",
				revision: "6422280d08bb8453a133c022ef110d6fdef41559",
				file: "chat_template.jinja",
				sha256: "cf12be1037dcb97b730227f70fb7a996c9b0ea5a153ae8d1b35472a8f2ef8fbd",
			},
		],
		templateTokens: { call: 10, argument: 2 },
	},
	{
		rule: "none",
		ids: /gpt-4o|gpt-4\.1|gpt-4(?![o.\d])|gpt-4-|gpt-3\.5|gpt-35|gpt-realtime|gpt-audio/,
		examples: ["gpt-4o", "gpt-4.1-mini"],
		templates: [],
		note: "o200k and cl100k models with no reasoning to replay",
	},
];

/** The pinned rule group for a catalogue id: the first whose pattern matches. */
export function pinnedRule(id: string): PinnedRule | undefined {
	const s = id.toLowerCase();
	return REASONING_RULES.find((r) => r.ids.test(s));
}

/** The pinned rule for a catalogue id, or undefined (not pinned). */
export function reasoningRule(id: string): ReasoningRule | undefined {
	return pinnedRule(id)?.rule;
}
