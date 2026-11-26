import { describe, expect, it } from "vitest";
import { BUNDLED, DOWNLOADED, MAX_TOKENIZER_BYTES, TOKENIZERS } from "./table.ts";

describe("the tokenizer table", () => {
	it("bundles o200k and cl100k and downloads 33 files", () => {
		expect(BUNDLED.map((e) => e.id)).toEqual(["o200k", "cl100k"]);
		expect(DOWNLOADED.length).toBe(33);
		expect(new Set(TOKENIZERS.map((e) => e.id)).size).toBe(35);
	});

	it("pins every downloaded file's size and hash, as the design lists them", () => {
		expect(DOWNLOADED.map((e) => [e.id, e.size, e.sha256?.slice(0, 12)])).toEqual([
			["qwen35", 12_807_982, "5f9e4d4901a9"],
			["qwen38", 12_809_320, "0997f410c57a"],
			["qwen3", 11_422_654, "aeb13307a71a"],
			["qwen3-coder", 7_032_399, "19564a48c4f7"],
			["qwen3-vl", 7_032_403, "a5d85b6dcc53"],
			["qwen25", 7_031_645, "c0382117ea32"],
			["mimo25", 7_033_572, "633518aad78f"],
			["mimo25pro", 12_180_133, "cdd40b08814d"],
			["mimo26", 11_423_823, "ff15eb925890"],
			["glm5", 20_217_442, "19e773648cb4"],
			["glm45", 19_970_699, "934066501641"],
			["ds-v3", 7_847_652, "621ac2e32d0d"],
			["ds-r1", 7_847_602, "ecb6f9fc3698"],
			["ds-v31", 7_847_578, "32b34a41212e"],
			["ds-v32", 7_847_502, "cd050be35cae"],
			["ds-v4", 6_367_146, "8f9f37ca37fd"],
			["ds-v41flash", 6_367_257, "c90dfa01249d"],
			["kimi", 2_795_286, "b6c497a7469b"],
			["minimax-m2", 9_730_160, "757622126525"],
			["minimax-m1", 9_726_751, "369f547b736f"],
			["ling3", 12_205_732, "40fb9d7d7795"],
			["ling26", 7_663_328, "7e888e7579f9"],
			["inkling", 27_875_797, "9fb6333a7db8"],
			["inkling2-small", 26_178_678, "7f332727f9a3"],
			["nemotron3", 17_077_484, "623c34567aeb"],
			["nemotron3nano", 17_077_485, "c6021eb6847e"],
			["nemotron35vl", 17_077_366, "d0432ad8b1c2"],
			["mistral3", 17_077_420, "99cf274236c6"],
			["mistral-large3", 17_078_110, "577575622324"],
			["mistral-small31", 17_078_037, "b76085f99233"],
			["mistral-nemo", 9_264_445, "e11c71726323"],
			["mixtral", 1_961_548, "e553af6fff7d"],
			["gemma4", 32_169_626, "cc8d3a0ce364"],
		]);
	});

	it("gives each download a full revision and hash, a distinct file, and a size under the cap", () => {
		for (const e of DOWNLOADED) {
			expect(e.revision, e.id).toMatch(/^[0-9a-f]{40}$/);
			expect(e.sha256, e.id).toMatch(/^[0-9a-f]{64}$/);
			expect(e.repo, e.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
			expect(e.size, e.id).toBeLessThanOrEqual(MAX_TOKENIZER_BYTES);
		}
		// One entry per distinct file: byte-identical files share one entry.
		expect(new Set(DOWNLOADED.map((e) => e.sha256)).size).toBe(DOWNLOADED.length);
	});

	it("loads Kimi's tiktoken.model with js-tiktoken and every other download with the Hugging Face library", () => {
		for (const e of DOWNLOADED)
			expect([e.id, e.loader, e.file]).toEqual(
				e.id === "kimi" ? ["kimi", "tiktoken", "tiktoken.model"] : [e.id, "hf", "tokenizer.json"],
			);
	});

	it("links each license at the pinned revision, or the page that states it", () => {
		const pages: Record<string, string> = {
			"minimax-m2": "https://github.com/MiniMax-AI/MiniMax-M2/blob/a01f06af0e56b2bc992c81354155fa9c29d8a2ed/LICENSE",
			nemotron3: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/",
			nemotron3nano:
				"https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/",
			nemotron35vl: "https://openmdw.ai/license/1-1/",
		};
		for (const e of DOWNLOADED) {
			if (pages[e.id]) expect(e.licenseUrl, e.id).toBe(pages[e.id]);
			else expect(e.licenseUrl, e.id).toMatch(new RegExp(`^https://huggingface.co/${e.repo}/blob/${e.revision}/`));
		}
		expect(DOWNLOADED.find((e) => e.id === "nemotron35vl")?.license).toBe("OpenMDW-1.1");
	});
});
