/**
 * P5: with compaction.enabled not false, the engine refuses to run: a clear error, a shutdown request,
 * and no model request. Port: a host that turns compaction off when the setting is unset (PENpi's fork
 * default) says so through EngineWiring.compactionOffByDefault; an explicit true still refuses.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";
import { createContextEngine, ENGINE_LABEL } from "./engine.ts";
import { finalTurn, report, scriptedModel } from "./helpers.ts";

describe("P5: refuse to run with compaction enabled", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const [label, settings, offByDefault, refused] of [
		["enabled: true", { compaction: { enabled: true } }, false, true],
		["setting absent (Pi default true)", {}, false, true],
		["enabled: false", { compaction: { enabled: false } }, false, false],
		["setting absent, host defaults to off (PENpi)", {}, true, false],
		["enabled: true, host defaults to off (PENpi)", { compaction: { enabled: true } }, true, true],
	] as const) {
		it(`p5 ${label}`, async () => {
			const notices: Array<{ message: string; type?: string }> = [];
			let shutdowns = 0;
			const harness = await createHarness({
				settings,
				extensionFactories: [createContextEngine({}, { compactionOffByDefault: offByDefault })],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message, type) => notices.push({ message, type }) }),
				shutdownHandler: () => {
					shutdowns++;
				},
			});
			const model = scriptedModel(harness);
			model.push(finalTurn("answered"));
			let promptError: string | undefined;
			await harness.session.prompt("hello").catch((error: Error) => {
				promptError = error.message;
			});
			report("p5", ENGINE_LABEL, label, {
				modelCalls: harness.faux.state.callCount,
				shutdowns,
				notices,
				promptError,
			});
			if (refused) {
				expect(harness.faux.state.callCount).toBe(0);
				expect(shutdowns).toBe(1);
				expect(notices.some((n) => n.type === "error" && n.message.includes("compaction.enabled"))).toBe(true);
			} else {
				expect(harness.faux.state.callCount).toBe(1);
				expect(shutdowns).toBe(0);
			}
		});
	}
});
