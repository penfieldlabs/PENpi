# Tokenizers

From 0.9.0 the context engine can count tokens with the model's own tokenizer instead of its
estimate. This page lists every tokenizer file the engine knows, where it comes from, its license,
and which of pi-ai's chat models use it. The table lives in
`.pi/extensions/penpi/engine/tokenizers/table.ts`, and the classifier that places each model in
`classify.ts`; their tests pin everything below.

**One entry per distinct file, by SHA-256.** Two models share an entry only when their files are
byte-identical. Files with the same vocabulary and merges but different added tokens get separate
entries, since they count text that holds those tokens differently.

## Bundled

o200k and cl100k come with [js-tiktoken 1.0.21](https://www.npmjs.com/package/js-tiktoken/v/1.0.21)
(MIT), and nothing is downloaded for them.

- **o200k:** GPT-4o to GPT-5, the o-series, Codex, `gpt-5-chat-latest` and gpt-oss.
- **cl100k:** GPT-4 and GPT-3.5.

## Downloaded on first use

33 files, from Hugging Face at a pinned revision. A file is used only when its size and SHA-256
match the table. The largest is 32,169,626 bytes.

| entry | repo, at the revision (other models) | revision | file | bytes | SHA-256 | license |
|---|---|---|---|---|---|---|
| `qwen35` | [Qwen/Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B/tree/1cda14dd71a3f47115850eb790f416f165da1cb5) (Qwen 3.5 and 3.6, every size) | `1cda14dd71a3` | `tokenizer.json` | 12,807,982 | `5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42` | [Apache-2.0](https://huggingface.co/Qwen/Qwen3.6-27B/blob/1cda14dd71a3f47115850eb790f416f165da1cb5/LICENSE) |
| `qwen38` | [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B/tree/37561816e66b5b9153b1b64c10968c18c1e6f4a0) | `37561816e66b` | `tokenizer.json` | 12,809,320 | `0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3` | [Apache-2.0](https://huggingface.co/Qwen/Qwen3.8-27B/blob/37561816e66b5b9153b1b64c10968c18c1e6f4a0/LICENSE) |
| `qwen3` | [Qwen/Qwen3-32B](https://huggingface.co/Qwen/Qwen3-32B/tree/9216db5781bf21249d130ec9da846c4624c16137) (Qwen 3 8B to 235B, 2507 Instruct, Next) | `9216db5781bf` | `tokenizer.json` | 11,422,654 | `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4` | [Apache-2.0](https://huggingface.co/Qwen/Qwen3-32B/blob/9216db5781bf21249d130ec9da846c4624c16137/LICENSE) |
| `qwen3-coder` | [Qwen/Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/tree/b2cff646eb4bb1d68355c01b18ae02e7cf42d120) (Qwen3-Coder and Qwen3-235B-A22B-Thinking-2507) | `b2cff646eb4b` | `tokenizer.json` | 7,032,399 | `19564a48c4f71a2a1b937cce34c737a1e662b171c5f5d7edf641a15cd896f07d` | [Apache-2.0](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/b2cff646eb4bb1d68355c01b18ae02e7cf42d120/LICENSE) |
| `qwen3-vl` | [Qwen/Qwen3-VL-8B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/tree/0c351dd01ed87e9c1b53cbc748cba10e6187ff3b) | `0c351dd01ed8` | `tokenizer.json` | 7,032,403 | `a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7` | [Apache-2.0](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/blob/0c351dd01ed87e9c1b53cbc748cba10e6187ff3b/README.md) |
| `qwen25` | [Qwen/Qwen2.5-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/tree/a09a35458c702b33eeacc393d103063234e8bc28) (also Qwen2.5-Coder-32B) | `a09a35458c70` | `tokenizer.json` | 7,031,645 | `c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539` | [Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/a09a35458c702b33eeacc393d103063234e8bc28/LICENSE) |
| `mimo25` | [XiaomiMiMo/MiMo-V2.5](https://huggingface.co/XiaomiMiMo/MiMo-V2.5/tree/d6bf9db68673d1f903a53d8da417b293fdc97d1f) | `d6bf9db68673` | `tokenizer.json` | 7,033,572 | `633518aad78f9f61bae2ae420d621215754a4424c918b052cd8c22a3b59e99d2` | [MIT](https://huggingface.co/XiaomiMiMo/MiMo-V2.5/blob/d6bf9db68673d1f903a53d8da417b293fdc97d1f/README.md) |
| `mimo25pro` | [XiaomiMiMo/MiMo-V2.5-Pro](https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro/tree/98e90df48208087a2eb974866a736a20f8122d2a) | `98e90df48208` | `tokenizer.json` | 12,180,133 | `cdd40b08814d626d2ab1eb36c7ca66521a96bce4d478cf1375a4d45fe03e1cf9` | [MIT](https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro/blob/98e90df48208087a2eb974866a736a20f8122d2a/README.md) |
| `mimo26` | [XiaomiMiMo/MiMo-V2.6-Pro-RL](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/tree/a066ba0057192126bd5d255f37138265fc1a435e) (the V2.6 Flash and Pro repos are not public) | `a066ba005719` | `tokenizer.json` | 11,423,823 | `ff15eb925890d6b71b5160de4b846fbd13178438ab463b38ecc953e8cd1dcb3e` | [MIT](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/blob/a066ba0057192126bd5d255f37138265fc1a435e/README.md) |
| `glm5` | [zai-org/GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash/tree/46a050bec13002ad29ee795c16e61cf4fa3c4a9c) (also GLM-5, 5.1, 5.2 and 4.7-Flash) | `46a050bec130` | `tokenizer.json` | 20,217,442 | `19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d` | [MIT](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/46a050bec13002ad29ee795c16e61cf4fa3c4a9c/LICENSE) |
| `glm45` | [zai-org/GLM-4.7](https://huggingface.co/zai-org/GLM-4.7/tree/602d01efcdd332c5238ca4bcede555defbe83eb7) (also GLM-4.5, 4.5-Air, 4.5V, 4.6 and 4.6V) | `602d01efcdd3` | `tokenizer.json` | 19,970,699 | `9340665016419c825c4bdabbcc9acc43b7ca2c68ce142724afa829abb1be5efd` | [MIT](https://huggingface.co/zai-org/GLM-4.7/blob/602d01efcdd332c5238ca4bcede555defbe83eb7/README.md) |
| `ds-v3` | [deepseek-ai/DeepSeek-V3-0324](https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/tree/e9b33add76883f293d6bf61f6bd89b497e80e335) (also DeepSeek-V3) | `e9b33add7688` | `tokenizer.json` | 7,847,652 | `621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41` | [MIT](https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/blob/e9b33add76883f293d6bf61f6bd89b497e80e335/LICENSE) |
| `ds-r1` | [deepseek-ai/DeepSeek-R1-0528](https://huggingface.co/deepseek-ai/DeepSeek-R1-0528/tree/4236a6af538feda4548eca9ab308586007567f52) (also DeepSeek-R1) | `4236a6af538f` | `tokenizer.json` | 7,847,602 | `ecb6f9fc369894346f0511f4074ca75cee5cd5f3b06d02f1ba35fcd39f8e121d` | [MIT](https://huggingface.co/deepseek-ai/DeepSeek-R1-0528/blob/4236a6af538feda4548eca9ab308586007567f52/LICENSE) |
| `ds-v31` | [deepseek-ai/DeepSeek-V3.1](https://huggingface.co/deepseek-ai/DeepSeek-V3.1/tree/c0781d039fb7a1ba2abc4add0bdc293e92d2b8db) (also V3.1-Terminus and V3.2-Exp) | `c0781d039fb7` | `tokenizer.json` | 7,847,578 | `32b34a41212e92f62e859cbbea121ae705a1fabbf157d9acf22d134ecd8dcf70` | [MIT](https://huggingface.co/deepseek-ai/DeepSeek-V3.1/blob/c0781d039fb7a1ba2abc4add0bdc293e92d2b8db/LICENSE) |
| `ds-v32` | [deepseek-ai/DeepSeek-V3.2](https://huggingface.co/deepseek-ai/DeepSeek-V3.2/tree/a7e62ac04ecb2c0a54d736dc46601c5606cf10a6) | `a7e62ac04ecb` | `tokenizer.json` | 7,847,502 | `cd050be35cae877f8f0aa847f45aa87e23835a56ca32b29b28545597852784e5` | [MIT](https://huggingface.co/deepseek-ai/DeepSeek-V3.2/blob/a7e62ac04ecb2c0a54d736dc46601c5606cf10a6/LICENSE) |
| `ds-v4` | [deepseek-ai/DeepSeek-V4-Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/tree/b5968e9190ef611bbf34a7229255be88a0e937c1) (also DeepSeek-V4-Flash) | `b5968e9190ef` | `tokenizer.json` | 6,367,146 | `8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf` | [MIT](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/b5968e9190ef611bbf34a7229255be88a0e937c1/LICENSE) |
| `ds-v41flash` | [deepseek-ai/DeepSeek-V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/314113f8a7dadb388215396ba5fbee2c610a04d6) | `314113f8a7da` | `tokenizer.json` | 6,367,257 | `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b` | [MIT](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/LICENSE) |
| `kimi` | [moonshotai/Kimi-K2-Instruct](https://huggingface.co/moonshotai/Kimi-K2-Instruct/tree/fd1984e2b7a3350dbf7305fe73a4ede25c14de50) (the same file in Kimi K2 to K3.1) | `fd1984e2b7a3` | `tiktoken.model` | 2,795,286 | `b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103` | [Modified MIT](https://huggingface.co/moonshotai/Kimi-K2-Instruct/blob/fd1984e2b7a3350dbf7305fe73a4ede25c14de50/LICENSE) |
| `minimax-m2` | [MiniMaxAI/MiniMax-M2](https://huggingface.co/MiniMaxAI/MiniMax-M2/tree/2a6104622dd83ee7e424e7d218736021a56745bd) (also MiniMax M2.1, M2.5 and M2.7) | `2a6104622dd8` | `tokenizer.json` | 9,730,160 | `757622126525aeeb131756849d93298070ff3f0319c455ec8c5bb0f6b1cebbe8` | [Modified MIT](https://github.com/MiniMax-AI/MiniMax-M2/blob/a01f06af0e56b2bc992c81354155fa9c29d8a2ed/LICENSE) |
| `minimax-m1` | [MiniMaxAI/MiniMax-M1-80k](https://huggingface.co/MiniMaxAI/MiniMax-M1-80k/tree/8d1494b1a260e22040d5b9b2eb332eb44500b34d) | `8d1494b1a260` | `tokenizer.json` | 9,726,751 | `369f547b736fad84af7c5bd8523ab1414b7116b5d167d84a10cf37c45dc79348` | [Apache-2.0](https://huggingface.co/MiniMaxAI/MiniMax-M1-80k/blob/8d1494b1a260e22040d5b9b2eb332eb44500b34d/LICENSE) |
| `ling3` | [inclusionAI/Ling-3.1-flash-1019](https://huggingface.co/inclusionAI/Ling-3.1-flash-1019/tree/2109a6863fb14361eecc346ef98b3db88b8cdaee) (also Ling 3.0 flash and tiny) | `2109a6863fb1` | `tokenizer.json` | 12,205,732 | `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60` | [MIT](https://huggingface.co/inclusionAI/Ling-3.1-flash-1019/blob/2109a6863fb14361eecc346ef98b3db88b8cdaee/README.md) |
| `ling26` | [inclusionAI/Ling-2.6-flash](https://huggingface.co/inclusionAI/Ling-2.6-flash/tree/89f8441a870241ea8c36959b629393045d565e0e) | `89f8441a8702` | `tokenizer.json` | 7,663,328 | `7e888e7579f98ada2ec4d85c1ead2f24c50ae9cfd3be713cbbc0e48138b2b875` | [MIT](https://huggingface.co/inclusionAI/Ling-2.6-flash/blob/89f8441a870241ea8c36959b629393045d565e0e/README.md) |
| `inkling` | [thinkingmachines/Inkling](https://huggingface.co/thinkingmachines/Inkling/tree/828496eeae4c243ff1a22f7f28ff83694f2f7bc9) (also Inkling-Small) | `828496eeae4c` | `tokenizer.json` | 27,875,797 | `9fb6333a7db8fe5da90728e741e4a3ee4ac2ae12c5dd4958cc6f31688787d3c2` | [Apache-2.0](https://huggingface.co/thinkingmachines/Inkling/blob/828496eeae4c243ff1a22f7f28ff83694f2f7bc9/README.md) |
| `inkling2-small` | [thinkingmachines/Inkling-2-Small](https://huggingface.co/thinkingmachines/Inkling-2-Small/tree/885d78bfca61a7e9a498e33cfa7ad35850533b8c) | `885d78bfca61` | `tokenizer.json` | 26,178,678 | `7f332727f9a3f093dd452a39cc978e6757627e5dad1b0673aa4e75174f236dd6` | [Apache-2.0](https://huggingface.co/thinkingmachines/Inkling-2-Small/blob/885d78bfca61a7e9a498e33cfa7ad35850533b8c/README.md) |
| `nemotron3` | [nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16/tree/2dc98e2afe4face0e4ce40972a915c45368bd34a) (also Ultra and 3.5 Lightning) | `2dc98e2afe4f` | `tokenizer.json` | 17,077,484 | `623c34567aebb18582765289fbe23d901c62704d6518d71866e0e58db892b5b7` | [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) |
| `nemotron3nano` | [nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16/tree/bf77c3174f68ad409e1c2aa60daeb46e32d1c606) | `bf77c3174f68` | `tokenizer.json` | 17,077,485 | `c6021eb6847e682f89aa52d5eb6e8c7d902a23acfc8137e25211cf84828f1592` | [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) |
| `nemotron35vl` | [nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16/tree/fb0ee0bc6b3f70342afd8d84cb80dbadbaa8a1fe) | `fb0ee0bc6b3f` | `tokenizer.json` | 17,077,366 | `d0432ad8b1c2984a2e2dca82e1933e3fd5628df6e95c51fba4c3ee9950dce299` | [OpenMDW-1.1](https://openmdw.ai/license/1-1/) |
| `mistral3` | [mistralai/Ministral-3-8B-Instruct-2512](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512/tree/d2ff65a33fc5f72d77a65a2bc366feefd44ca320) (also Devstral 2) | `d2ff65a33fc5` | `tokenizer.json` | 17,077,420 | `99cf274236c60277fcfad861a5a1007518687ad06ba8938760f50b55ffa0b1ef` | [Apache-2.0](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512/blob/d2ff65a33fc5f72d77a65a2bc366feefd44ca320/README.md) |
| `mistral-large3` | [mistralai/Mistral-Large-3-675B-Instruct-2512](https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/tree/51330c9da67945183568346369a07be224e5e1b0) | `51330c9da679` | `tokenizer.json` | 17,078,110 | `577575622324b2e099e2648be26bdeb5e5815ffe66d7004e9e3ddbf421db6bf1` | [Apache-2.0](https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/blob/51330c9da67945183568346369a07be224e5e1b0/README.md) |
| `mistral-small31` | [mistralai/Mistral-Small-3.1-24B-Instruct-2503](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503/tree/6422280d08bb8453a133c022ef110d6fdef41559) | `6422280d08bb` | `tokenizer.json` | 17,078,037 | `b76085f9923309d873994d444989f7eb6ec074b06f25b58f1e8d7b7741070949` | [Apache-2.0](https://huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503/blob/6422280d08bb8453a133c022ef110d6fdef41559/README.md) |
| `mistral-nemo` | [mistralai/Mistral-Nemo-Instruct-2407](https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407/tree/04d8a90549d23fc6bd7f642064003592df51e9b3) | `04d8a90549d2` | `tokenizer.json` | 9,264,445 | `e11c71726323d33da7b8d6f6f269f1988931c0a52b7122bcdd8c05042974e0db` | [Apache-2.0](https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407/blob/04d8a90549d23fc6bd7f642064003592df51e9b3/README.md) |
| `mixtral` | [mistralai/Mixtral-8x22B-Instruct-v0.1](https://huggingface.co/mistralai/Mixtral-8x22B-Instruct-v0.1/tree/cc88a6cc19fbd17d9f1c0ee0b0d70a748dce698d) | `cc88a6cc19fb` | `tokenizer.json` | 1,961,548 | `e553af6fff7d7ad76e830608b218c5c0b0822998d5a1a96099a74cd3c1cb1a49` | [Apache-2.0](https://huggingface.co/mistralai/Mixtral-8x22B-Instruct-v0.1/blob/cc88a6cc19fbd17d9f1c0ee0b0d70a748dce698d/README.md) |
| `gemma4` | [google/gemma-4-31B-it](https://huggingface.co/google/gemma-4-31B-it/tree/842da3794eaa0b77d5f08bae87a17459d91ff475) | `842da3794eaa` | `tokenizer.json` | 32,169,626 | `cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f` | [Apache-2.0](https://huggingface.co/google/gemma-4-31B-it/blob/842da3794eaa0b77d5f08bae87a17459d91ff475/README.md) |

**License terms to know:**
- **MiniMax M2** (Modified MIT, pinned at GitHub `MiniMax-AI/MiniMax-M2`
  `a01f06af0e56b2bc992c81354155fa9c29d8a2ed`): a product above 100 million monthly active users or
  US$30 million annual recurring revenue must display "MiniMax M2".
- **Kimi** (Modified MIT): a product above 100 million monthly active users or US$20 million
  monthly revenue must display "Kimi K2".
- **NVIDIA Nemotron Open Model License** (Nemotron 3 Super and Nano): it binds the user by use,
  including an indemnity of NVIDIA. It is a web page, not a file at a revision.
- **OpenMDW-1.1** (Nemotron 3.5 Super VL), as its
  [model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16/blob/fb0ee0bc6b3f70342afd8d84cb80dbadbaa8a1fe/README.md)
  states at the pinned revision. It is permissive and accepted by use: use, change and sharing are granted without
  restriction. Whoever redistributes the file must include the license and keep its notices; PENpi doesn't, since Pi
  downloads the file to your machine, but redistributing the cache folder does. Rights end for anyone who sues
  claiming the materials infringe a patent or copyright. There is no warranty, and, unlike the Nemotron license, no
  indemnity.

## Downloads and the cache folder

The `tokenizer` setting in the `penpi` block decides where files come from, and `PENPI_TOKENIZER`
overrides it (an unknown value of either is reported and ignored):
- **`auto`** (default): a missing file is downloaded the first time a model needs it, with a notice
  naming the file, its size, the repo and the revision, and linking its license unless it is MIT or
  Apache-2.0.
- **`local`**: only bundled and already-cached files are used, and no request is ever made.
- **`estimate`**: no tokenizer at all; every model is counted with the estimate.

Files live in `<agent dir>/cache/penpi/tokenizers/`, named by their SHA-256.
- **Checks:** a file is read once, and its bytes are used only when their size and hash match the
  table; the tokenizer is built from exactly those bytes. It is checked again on each use, since the
  folder is yours to change. Anything at the path that isn't a regular file, or is the wrong size,
  is refused before it is read. A file that doesn't match is deleted and downloaded again, at most
  once a session; after that the model stays on the estimate.
- **The request:** an HTTPS request to `huggingface.co/<repo>/resolve/<revision>/<file>`, through
  Pi's HTTP settings, including its proxy. It asks for the file uncompressed, refuses any hop that
  isn't HTTPS, and follows at most 5 redirects.
- **Size limits:** a download of any size other than the table's is stopped. Nothing over 32 MB is
  ever written.
- **Several Pi processes** can download the same file at once. Each writes its own `.part` file and
  moves it into place once it checks out. A `.part` file left by a crash is removed after a day.
- **Disk:** a user who visits every family keeps about 400 MB here. Nothing is evicted; delete the
  folder to reclaim the space, and files are downloaded again when needed.

## Which models use them

Of pi-ai's 1,698 chat models, 847 (49.9%) have a file:
- **597 (35.2%) count exactly** for the budget and for detection.
- **250 are assumed names.** They count exactly for the budget, and detection stays on the
  estimate's rules until the name is confirmed by a provider doc, a count API, or a measured match
  on known content:
  - closed or API-only names placed by their generation, such as `qwen3.8-max` or `glm-5-turbo` (91);
  - GPT-5.1 to 5.6 (152): js-tiktoken maps only `gpt-5`, `-mini`, `-nano`, their dated ids and
    `gpt-5-chat-latest`, and no provider source maps the later generations to o200k;
  - aliases that name a family and can move to a new file: `kimi-latest`, `devstral-latest`,
    `ministral-3b-latest`, `ministral-8b-latest` and `deepseek-v4-flash-latest` (6);
  - `ling-3.2-flash`, which has no public repo (1).

**On the estimate:**
- **no public tokenizer:** Claude, Gemini, Grok, OpenAI's GPT-6 and Daybreak names and `chat-latest`, and Muse;
- **no file:** Qwen 3.7 and Qwen 4, and Mistral Large 2 and Pixtral Large;
- **aliases that name no generation:** `deepseek-chat`, `deepseek-flash`, `glm-latest`,
  `minimax-latest`, `qwen-max-latest`, `qwen-plus` and the like;
- **Mistral Small 3.2, Magistral Small** and the API names placed on them: their repos ship only
  `tekken.json`, which `@huggingface/tokenizers` can't read;
- **gated:** Llama and Gemma 3;
- **left out:** MiniMax M3 (its license), Mistral Large 4 (license "other", with no terms to pin),
  and Nemotron Nano v2 and Cosmos.

## For 0.10.0: xAI's counter

Not built in 0.9.0, and Grok stays on the estimate. Measured in 0.9.0's count checks:
- `tokenize-text` counts text only, per model: `grok-4.3` and `grok-4.7` tokenize differently.
- Billed input is the text plus a fixed preamble (about 187 tokens on `grok-4.3`, about 1,237 on
  `grok-4.7`), about 4 a message (1 after another user message), about 155 for tools, and 37 to 43
  for a small image.
- A delta of appended text matched billed input within 1 token on both models. There is no total,
  so no exact repeat.
- Only requests that append text alone could use it, about 6% of an agent session's requests.
- The counter's cost is undocumented, and the checked key's rate limiter refused requests sooner
  than a per-minute window would.
