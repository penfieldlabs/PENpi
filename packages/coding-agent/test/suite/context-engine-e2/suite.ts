/**
 * Shared body of the four matrix test files (one per mix, so vitest spreads them over its workers).
 * Each run writes <out>/<run>.json and <run>.engine.log; run-e2.sh then calls summarize.mjs.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EngineUnderTest, loadEngine } from "./engine-under-test.ts";
import { matrixConfigs } from "./matrix.ts";
import type { MixName } from "./mixes.ts";
import { outDir, runOne } from "./runner.ts";

export function recordEngine(engine: EngineUnderTest): string {
	const dir = outDir(engine);
	mkdirSync(dir, { recursive: true });
	const copy = join(dir, "engine.context-engine.ts");
	if (!existsSync(copy)) copyFileSync(engine.loaded, copy);
	writeFileSync(
		join(dir, "engine.json"),
		JSON.stringify(
			{ label: engine.label, sha256: engine.sha256, source: engine.source, loaded: engine.loaded, via: engine.via },
			null,
			2,
		),
	);
	return dir;
}

export async function matrixSuite(mix: MixName): Promise<void> {
	const engine = await loadEngine();
	const dir = recordEngine(engine);
	const configs = matrixConfigs(mix);
	describe(`E2 ${mix} (engine ${engine.label} ${engine.sha256.slice(0, 12)})`, () => {
		if (configs.length === 0) it.skip("no runs selected for this mix", () => {});
		for (const config of configs) {
			it(config.id, async () => {
				const { metrics, failures } = await runOne(engine, config);
				const c = metrics.criteria;
				console.log(
					`[E2] ${metrics.verdict} ${config.id} engine=${engine.label}@${engine.sha256.slice(0, 12)} calls=${metrics.calls} ` +
						`rej=${metrics.rejections.count}/${metrics.rejections.late}<=${metrics.rejections.allowance} max=${metrics.largest.shareOfBudget} ` +
						`mean-after-cut=${metrics.share.meanAfterFirstCut ?? metrics.share.mean} ` +
						`cuts=${metrics.cuts.count} breaks=${metrics.prefix.breaks} trunc=${metrics.silent?.truncated ?? "-"} ` +
						`lag=${metrics.silent ? (metrics.silent.lagToDetection ?? `${metrics.silent.truncated}(undetected)`) : "-"} ` +
						`${c.map((x) => `${x.id.split(" ")[0]}=${x.pass === null ? "n/a" : x.pass ? (x.note?.startsWith("vacuous") ? "vacuous" : "ok") : "FAIL"}`).join(" ")} ` +
						`${(metrics.runtimeMs / 1000).toFixed(1)}s -> ${dir}`,
				);
				if (process.env.E2_ASSERT !== "0") expect(failures).toEqual([]);
			}, 3_600_000);
		}
	});
}
