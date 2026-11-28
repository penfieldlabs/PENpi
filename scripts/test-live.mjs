// npm run test:live: the workspace tests with the caller's environment, so tests gated on API keys, OAuth tokens
// or cloud credentials reach live providers and can spend money. It runs only with PI_LIVE_E2E=1. `npm test` runs
// the same tests through ./test.sh, with an empty home and no keys, so it never reaches them.
import { spawnSync } from "node:child_process";

if (process.env.PI_LIVE_E2E !== "1") {
	console.error(
		"test:live reaches live provider APIs with your keys and can spend money. Set PI_LIVE_E2E=1 to run it; npm test runs the same tests isolated, without keys.",
	);
	process.exit(1);
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "test:workspaces"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
