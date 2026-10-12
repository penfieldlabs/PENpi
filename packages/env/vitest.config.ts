import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// PENpi fork: every test here drives the Rust daemon, which PENpi does not ship or build in CI.
// Without a daemon binary, skip them (with a warning) instead of failing on test/daemon.ts.
// Same lookup as test/daemon.ts.
const daemon =
	process.env.PI_ENV_DAEMON ??
	resolve(import.meta.dirname, `daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`);
const hasDaemon = existsSync(daemon);
if (!hasDaemon) {
	console.warn(`[pi-env] Skipping daemon tests: ${daemon} not found. Run npm run build:daemon to include them.`);
}

export default defineConfig({
	test: {
		environment: "node",
		...(hasDaemon ? {} : { exclude: ["test/**", "**/node_modules/**"], passWithNoTests: true }),
	},
	resolve: {
		conditions: ["source"],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
