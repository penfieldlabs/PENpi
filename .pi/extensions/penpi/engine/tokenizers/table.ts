/**
 * The tokenizer table (0.9.0): one entry per distinct tokenizer file, by SHA-256.
 *
 * Two models share an entry only when their files are byte-identical. Files with the same vocabulary and merges
 * but different added tokens are separate entries, since they count text holding those tokens differently.
 * o200k and cl100k come bundled with js-tiktoken. Every other entry is downloaded on first use from Hugging Face
 * at the pinned revision and checked against its size and hash. Which catalogue models use which entry is the
 * classifier's job (classify.ts). docs/tokenizers.md lists the same table with each license.
 */

/** How an entry's file is loaded: js-tiktoken ranks (bundled or a `tiktoken.model`) or `@huggingface/tokenizers`. */
export type TokenizerLoader = "bundled" | "tiktoken" | "hf";

export interface TokenizerEntry {
	id: string;
	loader: TokenizerLoader;
	/** Hugging Face repo, for a downloaded entry. */
	repo?: string;
	/** The full 40-character commit the file is fetched at. */
	revision?: string;
	/** The file's path in the repo. */
	file?: string;
	/** Bytes, exact. A download of any other size is refused. */
	size?: number;
	/** SHA-256 of the file, hex. */
	sha256?: string;
	license: string;
	/** The license at a fixed revision, or the page that states it when the repo carries no copy. */
	licenseUrl: string;
	/** Other models the file serves, or why an entry is placed as it is. */
	note?: string;
}

/** No file above this is ever downloaded or written (Gemma 4's is the largest, 32,169,626 bytes). */
export const MAX_TOKENIZER_BYTES = 32 * 1024 * 1024;

export const BUNDLED: TokenizerEntry[] = [
	{
		id: "o200k",
		loader: "bundled",
		license: "MIT",
		licenseUrl: "https://www.npmjs.com/package/js-tiktoken/v/1.0.21",
		note: "GPT-4o to GPT-5, the o-series, Codex, gpt-5-chat-latest and gpt-oss",
	},
	{
		id: "cl100k",
		loader: "bundled",
		license: "MIT",
		licenseUrl: "https://www.npmjs.com/package/js-tiktoken/v/1.0.21",
		note: "GPT-4 and GPT-3.5",
	},
];

export const DOWNLOADED: TokenizerEntry[] = [
	{
		id: "qwen35",
		loader: "hf",
		repo: "Qwen/Qwen3.6-27B",
		revision: "1cda14dd71a3f47115850eb790f416f165da1cb5",
		file: "tokenizer.json",
		size: 12_807_982,
		sha256: "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42",
		license: "Apache-2.0",
		licenseUrl: "https://huggingface.co/Qwen/Qwen3.6-27B/blob/1cda14dd71a3f47115850eb790f416f165da1cb5/LICENSE",
		note: "Qwen 3.5 and 3.6, every size",
	},
	{
		id: "qwen38",
		loader: "hf",
		repo: "Qwen/Qwen3.8-27B",
		revision: "37561816e66b5b9153b1b64c10968c18c1e6f4a0",
		file: "tokenizer.json",
		size: 12_809_320,
		sha256: "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3",
		license: "Apache-2.0",
		licenseUrl: "https://huggingface.co/Qwen/Qwen3.8-27B/blob/37561816e66b5b9153b1b64c10968c18c1e6f4a0/LICENSE",
	},
	{
		id: "qwen3",
		loader: "hf",
		repo: "Qwen/Qwen3-32B",
		revision: "9216db5781bf21249d130ec9da846c4624c16137",
		file: "tokenizer.json",
		size: 11_422_654,
		sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
		license: "Apache-2.0",
		licenseUrl: "https://huggingface.co/Qwen/Qwen3-32B/blob/9216db5781bf21249d130ec9da846c4624c16137/LICENSE",
		note: "Qwen 3 8B to 235B, 2507 Instruct, Next",
	},
	{
		id: "qwen3-coder",
		loader: "hf",
		repo: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
		revision: "b2cff646eb4bb1d68355c01b18ae02e7cf42d120",
		file: "tokenizer.json",
		size: 7_032_399,
		sha256: "19564a48c4f71a2a1b937cce34c737a1e662b171c5f5d7edf641a15cd896f07d",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/b2cff646eb4bb1d68355c01b18ae02e7cf42d120/LICENSE",
		note: "Qwen3-Coder and Qwen3-235B-A22B-Thinking-2507",
	},
	{
		id: "qwen3-vl",
		loader: "hf",
		repo: "Qwen/Qwen3-VL-8B-Instruct",
		revision: "0c351dd01ed87e9c1b53cbc748cba10e6187ff3b",
		file: "tokenizer.json",
		size: 7_032_403,
		sha256: "a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/blob/0c351dd01ed87e9c1b53cbc748cba10e6187ff3b/README.md",
	},
	{
		id: "qwen25",
		loader: "hf",
		repo: "Qwen/Qwen2.5-7B-Instruct",
		revision: "a09a35458c702b33eeacc393d103063234e8bc28",
		file: "tokenizer.json",
		size: 7_031_645,
		sha256: "c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/a09a35458c702b33eeacc393d103063234e8bc28/LICENSE",
		note: "also Qwen2.5-Coder-32B",
	},
	{
		id: "mimo25",
		loader: "hf",
		repo: "XiaomiMiMo/MiMo-V2.5",
		revision: "d6bf9db68673d1f903a53d8da417b293fdc97d1f",
		file: "tokenizer.json",
		size: 7_033_572,
		sha256: "633518aad78f9f61bae2ae420d621215754a4424c918b052cd8c22a3b59e99d2",
		license: "MIT",
		licenseUrl: "https://huggingface.co/XiaomiMiMo/MiMo-V2.5/blob/d6bf9db68673d1f903a53d8da417b293fdc97d1f/README.md",
	},
	{
		id: "mimo25pro",
		loader: "hf",
		repo: "XiaomiMiMo/MiMo-V2.5-Pro",
		revision: "98e90df48208087a2eb974866a736a20f8122d2a",
		file: "tokenizer.json",
		size: 12_180_133,
		sha256: "cdd40b08814d626d2ab1eb36c7ca66521a96bce4d478cf1375a4d45fe03e1cf9",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro/blob/98e90df48208087a2eb974866a736a20f8122d2a/README.md",
	},
	{
		id: "mimo26",
		loader: "hf",
		repo: "XiaomiMiMo/MiMo-V2.6-Pro-RL",
		revision: "a066ba0057192126bd5d255f37138265fc1a435e",
		file: "tokenizer.json",
		size: 11_423_823,
		sha256: "ff15eb925890d6b71b5160de4b846fbd13178438ab463b38ecc953e8cd1dcb3e",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/blob/a066ba0057192126bd5d255f37138265fc1a435e/README.md",
		note: "the V2.6 Flash and Pro repos are not public",
	},
	{
		id: "glm5",
		loader: "hf",
		repo: "zai-org/GLM-5.3-Flash",
		revision: "46a050bec13002ad29ee795c16e61cf4fa3c4a9c",
		file: "tokenizer.json",
		size: 20_217_442,
		sha256: "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d",
		license: "MIT",
		licenseUrl: "https://huggingface.co/zai-org/GLM-5.3-Flash/blob/46a050bec13002ad29ee795c16e61cf4fa3c4a9c/LICENSE",
		note: "also GLM-5, 5.1, 5.2 and 4.7-Flash",
	},
	{
		id: "glm45",
		loader: "hf",
		repo: "zai-org/GLM-4.7",
		revision: "602d01efcdd332c5238ca4bcede555defbe83eb7",
		file: "tokenizer.json",
		size: 19_970_699,
		sha256: "9340665016419c825c4bdabbcc9acc43b7ca2c68ce142724afa829abb1be5efd",
		license: "MIT",
		licenseUrl: "https://huggingface.co/zai-org/GLM-4.7/blob/602d01efcdd332c5238ca4bcede555defbe83eb7/README.md",
		note: "also GLM-4.5, 4.5-Air, 4.5V, 4.6 and 4.6V",
	},
	{
		id: "ds-v3",
		loader: "hf",
		repo: "deepseek-ai/DeepSeek-V3-0324",
		revision: "e9b33add76883f293d6bf61f6bd89b497e80e335",
		file: "tokenizer.json",
		size: 7_847_652,
		sha256: "621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/blob/e9b33add76883f293d6bf61f6bd89b497e80e335/LICENSE",
		note: "also DeepSeek-V3",
	},
	{
		id: "ds-r1",
		loader: "hf",
		repo: "deepseek-ai/DeepSeek-R1-0528",
		revision: "4236a6af538feda4548eca9ab308586007567f52",
		file: "tokenizer.json",
		size: 7_847_602,
		sha256: "ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/deepseek-ai/DeepSeek-R1-0528/blob/4236a6af538feda4548eca9ab308586007567f52/LICENSE",
		note: "also DeepSeek-R1",
	},
	{
		id: "ds-v31",
		loader: "hf",
		repo: "deepseek-ai/DeepSeek-V3.1",
		revision: "c0781d039fb7a1ba2abc4add0bdc293e92d2b8db",
		file: "tokenizer.json",
		size: 7_847_578,
		sha256: "32b34a41212e92f62e859cbbea121ae705a1fabbf157d9acf22d134ecd8dcf70",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/deepseek-ai/DeepSeek-V3.1/blob/c0781d039fb7a1ba2abc4add0bdc293e92d2b8db/LICENSE",
		note: "also V3.1-Terminus and V3.2-Exp",
	},
	{
		id: "ds-v32",
		loader: "hf",
		repo: "deepseek-ai/DeepSeek-V3.2",
		revision: "a7e62ac04ecb2c0a54d736dc46601c5606cf10a6",
		file: "tokenizer.json",
		size: 7_847_502,
		sha256: "cd050be35cae877f8f0aa847f45aa87e23835a56ca32b29b28545597852784e5",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/a7e62ac04ecb2c0a54d736dc46601c5606cf10a6/LICENSE",
	},
	{
		id: "ds-v4",
		loader: "hf",
		repo: "deepseek-ai/DeepSeek-V4-Pro",
		revision: "b5968e9190ef611bbf34a7229255be88a0e937c1",
		file: "tokenizer.json",
		size: 6_367_146,
		sha256: "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/b5968e9190ef611bbf34a7229255be88a0e937c1/LICENSE",
		note: "also DeepSeek-V4-Flash",
	},
	{
		id: "ds-v41flash",
		loader: "hf",
		repo: "deepseek-ai/DeepSeek-V4.1-Flash",
		revision: "314113f8a7dadb388215396ba5fbee2c610a04d6",
		file: "tokenizer.json",
		size: 6_367_257,
		sha256: "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/LICENSE",
	},
	{
		id: "kimi",
		loader: "tiktoken",
		repo: "moonshotai/Kimi-K2-Instruct",
		revision: "fd1984e2b7a3350dbf7305fe73a4ede25c14de50",
		file: "tiktoken.model",
		size: 2_795_286,
		sha256: "b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103",
		license: "Modified MIT",
		licenseUrl:
			"https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/fd1984e2b7a3350dbf7305fe73a4ede25c14de50/LICENSE",
		note: "the same file in Kimi K2 to K3.1",
	},
	{
		id: "minimax-m2",
		loader: "hf",
		repo: "MiniMaxAI/MiniMax-M2",
		revision: "2a6104622dd83ee7e424e7d218736021a56745bd",
		file: "tokenizer.json",
		size: 9_730_160,
		sha256: "757622126525aeeb131756849d93298070ff3f0319c455ec8c5bb0f6b1cebbe8",
		license: "Modified MIT",
		licenseUrl: "https://github.com/MiniMax-AI/MiniMax-M2/blob/a01f06af0e56b2bc992c81354155fa9c29d8a2ed/LICENSE",
		note: "also MiniMax M2.1, M2.5 and M2.7",
	},
	{
		id: "minimax-m1",
		loader: "hf",
		repo: "MiniMaxAI/MiniMax-M1-80k",
		revision: "8d1494b1a260e22040d5b9b2eb332eb44500b34d",
		file: "tokenizer.json",
		size: 9_726_751,
		sha256: "369f547b736fad84af7c5bd8523ab1414b7116b5d167d84a10cf37c45dc79348",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/MiniMaxAI/MiniMax-M1-80k/blob/8d1494b1a260e22040d5b9b2eb332eb44500b34d/LICENSE",
	},
	{
		id: "ling3",
		loader: "hf",
		repo: "inclusionAI/Ling-3.1-flash-1019",
		revision: "2109a6863fb14361eecc346ef98b3db88b8cdaee",
		file: "tokenizer.json",
		size: 12_205_732,
		sha256: "40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/inclusionAI/Ling-3.1-flash-1019/blob/2109a6863fb14361eecc346ef98b3db88b8cdaee/README.md",
		note: "also Ling 3.0 flash and tiny",
	},
	{
		id: "ling26",
		loader: "hf",
		repo: "inclusionAI/Ling-2.6-flash",
		revision: "89f8441a870241ea8c36959b629393045d565e0e",
		file: "tokenizer.json",
		size: 7_663_328,
		sha256: "7e888e7579f98ada2ec4d85c1ead2f24c50ae9cfd3be713cbbc0e48138b2b875",
		license: "MIT",
		licenseUrl:
			"https://huggingface.co/inclusionAI/Ling-2.6-flash/blob/89f8441a870241ea8c36959b629393045d565e0e/README.md",
	},
	{
		id: "inkling",
		loader: "hf",
		repo: "thinkingmachines/Inkling",
		revision: "828496eeae4c243ff1a22f7f28ff83694f2f7bc9",
		file: "tokenizer.json",
		size: 27_875_797,
		sha256: "9fb6333a7db8fe5da90728e741e4a3ee4ac2ae12c5dd4958cc6f31688787d3c2",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/thinkingmachines/Inkling/blob/828496eeae4c243ff1a22f7f28ff83694f2f7bc9/README.md",
		note: "also Inkling-Small",
	},
	{
		id: "inkling2-small",
		loader: "hf",
		repo: "thinkingmachines/Inkling-2-Small",
		revision: "885d78bfca61a7e9a498e33cfa7ad35850533b8c",
		file: "tokenizer.json",
		size: 26_178_678,
		sha256: "7f332727f9a3f093dd452a39cc978e6757627e5dad1b0673aa4e75174f236dd6",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/thinkingmachines/Inkling-2-Small/blob/885d78bfca61a7e9a498e33cfa7ad35850533b8c/README.md",
	},
	{
		id: "nemotron3",
		loader: "hf",
		repo: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
		revision: "2dc98e2afe4face0e4ce40972a915c45368bd34a",
		file: "tokenizer.json",
		size: 17_077_484,
		sha256: "623c34567aebb18582765289fbe23d901c62704d6518d71866e0e58db892b5b7",
		license: "NVIDIA Nemotron Open Model License",
		licenseUrl: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/",
		note: "also Ultra and 3.5 Lightning",
	},
	{
		id: "nemotron3nano",
		loader: "hf",
		repo: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
		revision: "bf77c3174f68ad409e1c2aa60daeb46e32d1c606",
		file: "tokenizer.json",
		size: 17_077_485,
		sha256: "c6021eb6847e682f89aa52d5eb6e8c7d902a23acfc8137e25211cf84828f1592",
		license: "NVIDIA Nemotron Open Model License",
		licenseUrl: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/",
	},
	{
		id: "nemotron35vl",
		loader: "hf",
		repo: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16",
		revision: "fb0ee0bc6b3f70342afd8d84cb80dbadbaa8a1fe",
		file: "tokenizer.json",
		size: 17_077_366,
		sha256: "d0432ad8b1c2984a2e2dca82e1933e3fd5628df6e95c51fba4c3ee9950dce299",
		license: "OpenMDW-1.1",
		licenseUrl: "https://openmdw.ai/license/1-1/",
	},
	{
		id: "mistral3",
		loader: "hf",
		repo: "mistralai/Ministral-3-8B-Instruct-2512",
		revision: "d2ff65a33fc5f72d77a65a2bc366feefd44ca320",
		file: "tokenizer.json",
		size: 17_077_420,
		sha256: "99cf274236c60277fcfad861a5a1007518687ad06ba8938760f50b55ffa0b1ef",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512/blob/d2ff65a33fc5f72d77a65a2bc366feefd44ca320/README.md",
		note: "also Devstral 2",
	},
	{
		id: "mistral-large3",
		loader: "hf",
		repo: "mistralai/Mistral-Large-3-675B-Instruct-2512",
		revision: "51330c9da67945183568346369a07be224e5e1b0",
		file: "tokenizer.json",
		size: 17_078_110,
		sha256: "577575622324b2e099e2648be26bdeb5e5815ffe66d7004e9e3ddbf421db6bf1",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/blob/51330c9da67945183568346369a07be224e5e1b0/README.md",
	},
	{
		id: "mistral-small31",
		loader: "hf",
		repo: "mistralai/Mistral-Small-3.1-24B-Instruct-2503",
		revision: "6422280d08bb8453a133c022ef110d6fdef41559",
		file: "tokenizer.json",
		size: 17_078_037,
		sha256: "b76085f9923309d873994d444989f7eb6ec074b06f25b58f1e8d7b7741070949",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503/blob/6422280d08bb8453a133c022ef110d6fdef41559/README.md",
	},
	{
		id: "mistral-nemo",
		loader: "hf",
		repo: "mistralai/Mistral-Nemo-Instruct-2407",
		revision: "04d8a90549d23fc6bd7f642064003592df51e9b3",
		file: "tokenizer.json",
		size: 9_264_445,
		sha256: "e11c71726323d33da7b8d6f6f269f1988931c0a52b7122bcdd8c05042974e0db",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407/blob/04d8a90549d23fc6bd7f642064003592df51e9b3/README.md",
	},
	{
		id: "mixtral",
		loader: "hf",
		repo: "mistralai/Mixtral-8x22B-Instruct-v0.1",
		revision: "cc88a6cc19fbd17d9f1c0ee0b0d70a748dce698d",
		file: "tokenizer.json",
		size: 1_961_548,
		sha256: "e553af6fff7d7ad76e830608b218c5c0b0822998d5a1a96099a74cd3c1cb1a49",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/mistralai/Mixtral-8x22B-Instruct-v0.1/blob/cc88a6cc19fbd17d9f1c0ee0b0d70a748dce698d/README.md",
	},
	{
		id: "gemma4",
		loader: "hf",
		repo: "google/gemma-4-31B-it",
		revision: "842da3794eaa0b77d5f08bae87a17459d91ff475",
		file: "tokenizer.json",
		size: 32_169_626,
		sha256: "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
		license: "Apache-2.0",
		licenseUrl:
			"https://huggingface.co/google/gemma-4-31B-it/blob/842da3794eaa0b77d5f08bae87a17459d91ff475/README.md",
	},
];

export const TOKENIZERS: TokenizerEntry[] = [...BUNDLED, ...DOWNLOADED];

const byId = new Map(TOKENIZERS.map((e) => [e.id, e]));

/** The entry with this id, or undefined. */
export function tokenizerEntry(id: string): TokenizerEntry | undefined {
	return byId.get(id);
}
