import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnyModel, isModelType } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifyModel } from "./classify.ts";
import { tokenizerEntry } from "./table.ts";

/** Every chat model in pi-ai's catalogue: the provider data files, models of type "chat". */
function chatModels(): string[] {
	const dir = fileURLToPath(new URL("../../../../../packages/ai/src/providers/data", import.meta.url));
	const ids: string[] = [];
	for (const file of readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()) {
		const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, Record<string, AnyModel>>;
		for (const models of Object.values(data))
			for (const model of Object.values(models))
				if (typeof model?.id === "string" && isModelType(model, "chat")) ids.push(model.id);
	}
	return ids;
}

describe("the tokenizer classifier on pi-ai's catalogue", () => {
	const ids = chatModels();
	const classes = ids.map(classifyModel);

	it("covers 847 of 1,698 chat models: 597 exact for detection, 250 assumed names", () => {
		expect(ids.length).toBe(1_698);
		expect(classes.filter((c) => c.entry !== undefined).length).toBe(847);
		expect(classes.filter((c) => c.status === "exact").length).toBe(597);
		expect(classes.filter((c) => c.status === "assumed").length).toBe(250);
	});

	it("places each entry's models, with the assumed names among them", () => {
		const counts: Record<string, [number, number]> = {};
		for (const c of classes) {
			if (c.entry === undefined) continue;
			counts[c.entry] ??= [0, 0];
			const n = counts[c.entry];
			n[0]++;
			if (c.status === "assumed") n[1]++;
		}
		expect(counts).toEqual({
			cl100k: [8, 0],
			"ds-r1": [4, 0],
			"ds-v3": [4, 0],
			"ds-v31": [5, 0],
			"ds-v32": [5, 0],
			"ds-v4": [40, 4],
			"ds-v41flash": [36, 0],
			gemma4: [15, 0],
			glm45: [21, 0],
			glm5: [89, 19],
			inkling: [8, 0],
			"inkling2-small": [5, 0],
			kimi: [82, 5],
			ling26: [3, 0],
			ling3: [11, 1],
			mimo25: [3, 0],
			mimo25pro: [3, 0],
			mimo26: [18, 18],
			"minimax-m1": [1, 0],
			"minimax-m2": [20, 0],
			"mistral-large3": [4, 0],
			"mistral-nemo": [4, 0],
			"mistral-small31": [3, 0],
			mistral3: [20, 4],
			mixtral: [1, 0],
			nemotron3: [16, 0],
			nemotron35vl: [6, 0],
			nemotron3nano: [4, 0],
			o200k: [291, 152],
			qwen25: [2, 0],
			qwen3: [23, 1],
			"qwen3-coder": [14, 1],
			"qwen3-vl": [8, 1],
			qwen35: [35, 17],
			qwen38: [35, 27],
		});
	});

	it("names only entries the table has", () => {
		for (const c of classes) if (c.entry !== undefined) expect(tokenizerEntry(c.entry), c.entry).toBeDefined();
	});

	it("one catalogue id per entry", () => {
		const one: Array<[string, string, "exact" | "assumed"]> = [
			["gpt-4", "cl100k", "exact"],
			["openai.gpt-oss-120b", "o200k", "exact"],
			["deepseek-ai/DeepSeek-R1", "ds-r1", "exact"],
			["deepseek.v3-v1:0", "ds-v3", "exact"],
			["deepseek-ai/DeepSeek-V3.1", "ds-v31", "exact"],
			["deepseek.v3.2", "ds-v32", "exact"],
			["deepseek-v4-pro", "ds-v4", "exact"],
			["deepseek-ai/DeepSeek-V4.1-Flash", "ds-v41flash", "exact"],
			["google.gemma-4-26b-a4b", "gemma4", "exact"],
			["zai.glm-4.7", "glm45", "exact"],
			["global.zai.glm-5.3", "glm5", "exact"],
			["thinkingmachines/Inkling", "inkling", "exact"],
			["workers-ai/@cf/thinkingmachines/inkling-2-small", "inkling2-small", "exact"],
			["global.moonshotai.kimi-k3", "kimi", "exact"],
			["Ling-2.6-1T", "ling26", "exact"],
			["inclusionai/ling-3.0-flash", "ling3", "exact"],
			["XiaomiMiMo/MiMo-V2.5", "mimo25", "exact"],
			["XiaomiMiMo/MiMo-V2.5-Pro", "mimo25pro", "exact"],
			["mimo-v2.6-flash", "mimo26", "assumed"],
			["MiniMaxAI/MiniMax-M1-80k", "minimax-m1", "exact"],
			["minimax.minimax-m2", "minimax-m2", "exact"],
			["mistral.mistral-large-3-675b-instruct", "mistral-large3", "exact"],
			["open-mistral-nemo", "mistral-nemo", "exact"],
			["workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct", "mistral-small31", "exact"],
			["mistral.devstral-2-123b", "mistral3", "exact"],
			["mistralai/mixtral-8x22b-instruct", "mixtral", "exact"],
			["nvidia.nemotron-super-3-120b", "nemotron3", "exact"],
			["nvidia/nemotron-3.5-super-vl-120b-a12b", "nemotron35vl", "exact"],
			["nvidia.nemotron-nano-3-30b", "nemotron3nano", "exact"],
			["Qwen/Qwen2.5-Coder-32B-Instruct", "qwen25", "exact"],
			["qwen.qwen3-235b-a22b-2507-v1:0", "qwen3", "exact"],
			["qwen.qwen3-coder-30b-a3b-v1:0", "qwen3-coder", "exact"],
			["qwen.qwen3-vl-235b-a22b", "qwen3-vl", "exact"],
			["qwen/qwen3.6-27b", "qwen35", "exact"],
			["qwen-3.8-27b", "qwen38", "exact"],
		];
		for (const [id, entry, status] of one) expect(classifyModel(id), id).toEqual({ status, entry });
		expect(new Set(one.map((r) => r[1])).size).toBe(35);
	});
});

describe("the classifier rows review found", () => {
	const is = (id: string, status: string, entry?: string) =>
		expect(classifyModel(id), id).toMatchObject(entry ? { status, entry } : { status });

	it("Qwen 3.8 under its own file, Qwen 4 with none", () => {
		is("accounts/fireworks/models/qwen3p8-2p4t-a95b", "assumed", "qwen38");
		is("accounts/fireworks/models/qwen3p8-max", "assumed", "qwen38");
		is("qwen4-max", "none");
		is("qwen4-max-preview", "none");
		is("alibaba/qwen4-max", "none");
	});

	it("Mistral Large 2 and Pixtral Large have no entry; Mistral Large 4 is left out", () => {
		is("mistralai/mistral-large", "none");
		is("mistralai/mistral-large-2407", "none");
		is("mistral.pixtral-large-2502-v1:0", "none");
		is("eu.mistral.pixtral-large-2502-v1:0", "none");
		is("mistral-large-4", "out");
		is("mistralai/mistral-large-4-0", "out");
		is("mistral/mistral-large-3", "exact", "mistral-large3");
	});

	it("the Tekken files stay on the estimate", () => {
		is("mistralai/mistral-small-3.2-24b-instruct", "none");
		is("mistral.magistral-small-2509", "none");
		expect(classifyModel("mistral.magistral-small-2509").reason).toContain("tekken.json");
	});

	it("Inkling has its own two files, apart from Ling 3.1", () => {
		is("thinkingmachines/inkling", "exact", "inkling");
		is("thinkingmachines/inkling-small", "exact", "inkling");
		is("thinkingmachines/inkling-small:batch", "exact", "inkling");
		is("thinkingmachines/inkling-2-small", "exact", "inkling2-small");
		is("@cf/thinkingmachines/inkling-2-small", "exact", "inkling2-small");
		is("inclusionai/ling-3.1-flash", "exact", "ling3");
		is("inclusionai/ling-3.2-flash:free", "assumed", "ling3");
	});

	it("aliases that can move to a new file are assumed; gpt-5-chat-latest is in js-tiktoken's map", () => {
		is("~moonshotai/kimi-latest", "assumed", "kimi");
		is("accounts/fireworks/routers/kimi-latest", "assumed", "kimi");
		is("devstral-latest", "assumed", "mistral3");
		is("ministral-3b-latest", "assumed", "mistral3");
		is("ministral-8b-latest", "assumed", "mistral3");
		is("~deepseek/deepseek-v4-flash-latest", "assumed", "ds-v4");
		is("gpt-5-chat-latest", "exact", "o200k");
	});

	it("GPT-5.1 and later are assumed on o200k; GPT-5 is exact", () => {
		is("gpt-5", "exact", "o200k");
		is("gpt-5-mini", "exact", "o200k");
		is("gpt-5.1", "assumed", "o200k");
		is("openai/gpt-5.1", "assumed", "o200k");
		is("gpt-5.6-sol-pro:batch", "assumed", "o200k");
		is("us.openai.gpt-5.6-terra", "assumed", "o200k");
	});

	it("names with no public tokenizer", () => {
		is("~anthropic/claude-fable-latest", "none");
		is("gemini-pro-latest", "none");
		is("~x-ai/grok-latest", "none");
		is("gpt-daybreak-red-latest", "none");
		is("accounts/fireworks/routers/glm-latest", "none");
		is("accounts/fireworks/routers/minimax-latest", "none");
	});
});
