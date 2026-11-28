import config from "./vitest.config.ts";

// The fast loop's engine tests (npm run test:penpi): the suite without its sweeps and honest runs, which take most
// of its time (about 1,470 of 1,820 s of test time). npm test and CI still run every file.
const SLOW = [
	"floor-sweep.test.ts",
	"v090-exact-scripts.test.ts",
	"d24-honest-switch.test.ts",
	"v090-honest-detection.test.ts",
	"honest-provider.test.ts",
	"claude-counts.test.ts",
];
config.test = {
	...config.test,
	exclude: [...(config.test?.exclude ?? []), ...SLOW.map((f) => `test/suite/context-engine/${f}`)],
};
export default config;
