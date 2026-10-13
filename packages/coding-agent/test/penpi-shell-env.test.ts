/**
 * PENpi strips Penfield credentials from the environment of agent-spawned shell commands.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellEnv } from "../src/utils/shell.ts";

const CREDENTIALS = ["PENFIELD_JWT", "PENPI_PENFIELD_API_KEY"] as const;

describe("getShellEnv strips Penfield credentials", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const name of CREDENTIALS) {
			saved[name] = process.env[name];
			process.env[name] = `secret-${name}`;
		}
	});
	afterEach(() => {
		for (const name of CREDENTIALS) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	it.each(CREDENTIALS)("does not pass %s to shell commands", (name) => {
		const env = getShellEnv();
		expect(env[name]).toBeUndefined();
		// The process itself keeps it: the embedded adapter and PENpi read process.env directly.
		expect(process.env[name]).toBe(`secret-${name}`);
	});
});
