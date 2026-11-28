// npm run test:live refuses to start without PI_LIVE_E2E=1 (scripts/test-live.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "test-live.mjs");

describe("test:live", () => {
	it("refuses to start without PI_LIVE_E2E=1, and starts no npm", () => {
		for (const live of [undefined, "", "0", "true"]) {
			const env = { PATH: "/nonexistent", OPENAI_API_KEY: "dummy" };
			if (live !== undefined) env.PI_LIVE_E2E = live;
			const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
			assert.equal(result.status, 1, `PI_LIVE_E2E=${live}`);
			assert.match(result.stderr, /Set PI_LIVE_E2E=1 to run it/);
		}
	});
});
