/**
 * D9 (port): the pin cap is in provider tokens, so it is compared with the calibrated estimate (estimate x
 * the model's ratio), as unit caps are (E4.2). Comparing the raw estimate let dense text (CJK) exceed the
 * cap by the calibration ratio.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { createContextEngine, newStats, textTokens } from "./engine.ts";
import { finalTurn, installProviderSim, scriptedModel, toolTurn, workExtension } from "./helpers.ts";

const CJK = "数据库连接在第四个分片上超时，请先检查连接池的配置，然后重新运行迁移脚本并记录每一步的耗时。";

describe("D9: the pin cap in provider tokens", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("d9 a CJK pin at a 1.7 calibration ratio stays within the cap in provider tokens", async () => {
		const stats = newStats();
		const lines: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-32k", contextWindow: 32_000, maxTokens: 4_000 }],
			settings: { compaction: { enabled: false } },
			// Cap: 5% of the 32k window = 1,600 provider tokens.
			extensionFactories: [
				workExtension,
				createContextEngine({ stats, log: (l) => lines.push(l), pinUserMessages: { capFraction: 0.05 } }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// The provider counts 1.7 tokens for each one the estimator expects: the ratio settles near 1.7.
		installProviderSim(harness, { scale: 1.7 });
		let pin = "";
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (m, context, o) => {
			for (const msg of context.messages) {
				const c = msg.content as string | Array<{ type: string; text?: string }>;
				const text = typeof c === "string" ? c : c.map((b) => b.text ?? "").join("\n");
				const a = text.indexOf("<pinned-user-messages>");
				if (a >= 0)
					pin = text.slice(a, text.indexOf("</pinned-user-messages>", a) + "</pinned-user-messages>".length);
			}
			return inner(m, context, o);
		};
		const model = scriptedModel(harness, 400);
		for (let i = 0; i < 10; i++) {
			model.push(finalTurn("好的。"));
			await harness.session.prompt(`规则 ${i}：${CJK.repeat(25)}`);
		}
		for (let t = 0; t < 30; t++) model.push(toolTurn(4_000 + (t % 3) * 1_000, 3_000 + t));
		model.push(finalTurn("done"));
		await harness.session.prompt("按照上面的规则处理所有分片。");

		expect(stats.cuts.length).toBeGreaterThan(0);
		const ratio = stats.sent.at(-1)?.ratio ?? 0;
		expect(ratio).toBeGreaterThan(1.5);
		const cap = 1_600;
		expect(lines.some((l) => /pin #\d+: .*\(cap 1600\)/.test(l))).toBe(true);
		// The cap had to act: the carried CJK text alone is far above it.
		expect(textTokens(CJK.repeat(25)) * 10 * ratio).toBeGreaterThan(2 * cap);
		expect(pin.length).toBeGreaterThan(0);
		// In provider tokens (the estimate at the model's ratio), the pin is within the cap.
		expect(textTokens(pin) * ratio).toBeLessThanOrEqual(cap);
	});
});
