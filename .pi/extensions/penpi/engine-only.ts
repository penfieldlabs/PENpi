/**
 * PENpi's context engine without Penfield memory, MCP or PENpi's other features: the entry point for the
 * release-gate benchmark (`pi -e <repo>/.pi/extensions/penpi/engine-only.ts`). Penfield memory must stay out of
 * the benchmark, because it would carry facts across sessions and arms. The engine is built by the same
 * function, from the same settings and defaults, as in the full extension (index.ts); here it registers
 * /penpi itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPenpiEngine } from "./engine/entry.ts";

export default function penpiEngineOnly(pi: ExtensionAPI): void {
	installPenpiEngine(pi, { registerCommand: true });
}
