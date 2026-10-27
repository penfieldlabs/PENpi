import { Type } from "@earendil-works/pi-ai";
import type { EngineCore } from "../core.ts";
import { NOTES_TOOL } from "../options.ts";

export function installNotes(core: EngineCore): void {
	const { pi, opts } = core;

	// --------------------------------------------------------------- tools (E4, E8)
	pi.registerTool({
		name: NOTES_TOOL,
		label: "Context notes",
		description:
			"Replace your pinned working notes: a short block (goal, decisions, open threads, next steps) that stays in your context permanently, even after older messages leave the window. Optionally replace the pinned task statement.",
		parameters: Type.Object({
			notes: Type.String({ description: "The complete new notes block (replaces the previous one)." }),
			task: Type.Optional(Type.String({ description: "Replace the pinned task statement." })),
		}),
		execute: async (_id, params) => {
			if (params.notes.length > opts.notesMaxChars) {
				throw new Error(
					`Notes are ${params.notes.length} characters; the limit is ${opts.notesMaxChars}. Shorten them.`,
				);
			}
			const task = params.task?.slice(0, opts.taskMaxChars);
			return {
				content: [
					{ type: "text", text: `Pinned notes updated (${params.notes.length}/${opts.notesMaxChars} chars).` },
				],
				details: { notes: params.notes, ...(task ? { task } : {}) },
			};
		},
	});
}
