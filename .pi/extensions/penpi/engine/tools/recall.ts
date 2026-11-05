import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { EngineCore } from "../core.ts";
import { type Block, textOfContent, textTokens } from "../estimator.ts";
import { RECALL_TOOL } from "../options.ts";
import { contributesMessages } from "../planner.ts";
import { pairToolResults } from "./search.ts";

export function installRecall(core: EngineCore): void {
	const { pi } = core;

	pi.registerTool({
		name: RECALL_TOOL,
		label: "Context recall",
		description:
			"Read the verbatim content of a session entry by id (content shown truncated, images not shown, or messages that left the context window): text in pages, or one image by index.",
		parameters: Type.Object({
			entry: Type.String(),
			offset: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
			image: Type.Optional(Type.Number({ description: "Index of the content block holding the image." })),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const entry = ctx.sessionManager.getEntry(params.entry);
			if (!entry || !contributesMessages(entry)) throw new Error(`No readable entry ${params.entry}`);
			const content =
				entry.type === "message"
					? (entry.message as { content?: unknown }).content
					: entry.type === "custom_message"
						? entry.content
						: entry.type === "branch_summary"
							? entry.summary
							: "";
			if (params.image !== undefined) {
				const block = Array.isArray(content) ? (content as Block[])[params.image] : undefined;
				if (!block || block.type !== "image")
					throw new Error(`Entry ${params.entry} has no image at index ${params.image}`);
				return {
					content: [
						{ type: "text", text: `[entry ${params.entry} image at index ${params.image}]` },
						block as ImageContent,
					],
					details: { entry: params.entry, image: params.image },
				};
			}
			const text = textOfContent(content);
			const limits = core.resolveLimits(ctx);
			const density = textTokens(text) / Math.max(1, text.length);
			const page = Math.min(
				params.limit ?? Number.POSITIVE_INFINITY,
				Math.floor((core.maxUnitTokens(limits) * 0.9) / Math.max(density, 0.05) / core.ratioFor(limits.key)),
			);
			const offset = Math.max(0, params.offset ?? 0);
			const slice = text.slice(offset, offset + page);
			// 0.6.1 (the 0.6.0 gate's candidate s10): a tool call's entry holds only the call, e.g.
			// `read({"path":...})`, and the model took that for the whole answer. On the entry's last page, each call's
			// result follows: in full when it fits what is left of the page, else a line naming its entry to recall.
			const results: string[] = [];
			const shown: string[] = [];
			if (entry.type === "message" && offset + slice.length >= text.length && Array.isArray(content)) {
				const { resultOfBlock } = pairToolResults(ctx.sessionManager.getBranch());
				let room = page - slice.length;
				(content as Block[]).forEach((block, index) => {
					if (block.type !== "toolCall") return;
					const resultId = resultOfBlock.get(`${params.entry}#${index}`);
					if (!resultId) return;
					const result = ctx.sessionManager.getEntry(resultId);
					const resultText =
						result?.type === "message" ? textOfContent((result.message as { content?: unknown }).content) : "";
					const head = `[result of ${block.name}: entry ${resultId}, ${resultText.length} characters]`;
					if (resultText.length + head.length + 2 <= room) {
						results.push(`${head}\n${resultText}`);
						room -= resultText.length + head.length + 2;
						shown.push(resultId);
					} else
						results.push(
							`[result of ${block.name}: entry ${resultId}, ${resultText.length} characters; read it with ${RECALL_TOOL}({"entry":"${resultId}"})]`,
						);
				});
			}
			return {
				content: [
					{
						type: "text",
						text: `[entry ${params.entry} characters ${offset}-${offset + slice.length} of ${text.length}]\n${slice}${results.length ? `\n${results.join("\n")}` : ""}`,
					},
				],
				details: {
					entry: params.entry,
					offset,
					length: slice.length,
					total: text.length,
					...(results.length ? { results: results.length, resultsShown: shown } : {}),
				},
			};
		},
	});
}
