/**
 * 0.9.0: a session on the exact path for the engine tests. The model is counted by the engine's tokenizer worker, and the
 * simulated provider counts what it receives with a tokenizer too (fauxPromptParts), plus a few template tokens a
 * message, so exact and reported counts can be compared. Each session ends as Pi's runtime ends one, which frees the
 * worker (endSession).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineStats } from "../../../../../.pi/extensions/penpi/engine/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats } from "./engine.ts";
import {
	endSession,
	finalTurn,
	installProviderSim,
	type ProviderSim,
	scriptedModel,
	toolTurn,
	workExtension,
} from "./helpers.ts";

/** Template tokens the provider adds per message. */
export const TEMPLATE = 3;

export interface ExactSession {
	harness: Harness;
	stats: EngineStats;
	lines: string[];
	reports: string[];
	sim: ProviderSim;
	model: ReturnType<typeof scriptedModel>;
}

const open: Array<{ harness: Harness; dir: string }> = [];

/** End every session these tests opened, and remove their tokenizer folders. */
export async function endExactSessions(): Promise<void> {
	while (open.length > 0) {
		const { harness, dir } = open.pop()!;
		await endSession(harness);
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function until(condition: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export async function exactSession(
	modelId: string,
	options: {
		/** The provider's count of one message's text (defaults to none: chars / 4 x scale). */
		count?: (text: string) => number;
		engine?: Record<string, unknown>;
		window?: number;
		sim?: Parameters<typeof installProviderSim>[1];
		tools?: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<ExactSession> {
	const stats = newStats();
	const lines: string[] = [];
	const reports: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "penpi-tokenizers-"));
	const harness = await createHarness({
		models: [{ id: modelId, contextWindow: options.window ?? 32_000, maxTokens: 4_000 }],
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			workExtension,
			...(options.tools ?? []),
			createContextEngine({
				stats,
				env: {},
				tokenizerCacheDir: dir,
				log: (line: string) => lines.push(line),
				report: (json: string) => reports.push(json),
				...options.engine,
			}),
		],
	});
	open.push({ harness, dir });
	await harness.session.bindExtensions({});
	const count = options.count;
	const sim = installProviderSim(harness, {
		...(count ? { countTokens: (parts: string[]) => parts.reduce((sum, p) => sum + count(p) + TEMPLATE, 0) } : {}),
		...options.sim,
	});
	const model = scriptedModel(harness);
	return { harness, stats, lines, reports, sim, model };
}

/** A prompt of tool turns of the given sizes, then a final answer. */
export async function prompt(s: ExactSession, sizes: number[], seed: number, text = `Task ${seed}`): Promise<void> {
	sizes.forEach((size, i) => {
		s.model.push(toolTurn(size, seed * 100 + i));
	});
	s.model.push(finalTurn(`done ${seed}`));
	await s.harness.session.prompt(text);
}

/** Wait until the session's tokenizer is ready (its counting line says exact). */
export async function exactReady(s: ExactSession): Promise<void> {
	await until(() => s.reports.some((r) => r.includes('"path":"exact"')));
}
