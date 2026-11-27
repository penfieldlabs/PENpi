/**
 * 0.9.0: no engine test reaches a real count endpoint (countapi.ts). A test's count goes to a fake (countApiFetch); one
 * that would reach Anthropic's or Google's API instead fails, here, rather than skipping or spending.
 */
import { afterEach, expect } from "vitest";

const REAL_HOSTS = ["api.anthropic.com", "generativelanguage.googleapis.com"];
const reached: string[] = [];
const real = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	let host = "";
	try {
		host = new URL(url).host;
	} catch {}
	if (REAL_HOSTS.includes(host)) {
		reached.push(url);
		throw new Error(`a test reached a real count endpoint: ${url}`);
	}
	return real(input, init);
}) as typeof fetch;

afterEach(() => {
	expect(reached.splice(0), "a test reached a real count endpoint").toEqual([]);
});
