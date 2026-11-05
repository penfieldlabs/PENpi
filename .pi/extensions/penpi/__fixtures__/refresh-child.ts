/**
 * One PENpi process for penfield-refresh-processes.test.ts (0.6.1): a TokenManager on a shared token store, its
 * Penfield traffic sent to the test's rotating fixture. Prints one JSON line per getAccessToken() call.
 *
 * Environment: STORE (the token store), PORT (the fixture), AT_TIMES (comma-separated epoch ms at which to call
 * getAccessToken; a past time means at once). With LOGOUT_AT (epoch ms) it is a `/penpi logout` instead: it removes
 * the store at that time (deleteTokenStore, as the command does) and prints whether one was there.
 */
import { deleteTokenStore, TokenManager } from "../penfield-client.ts";

const port = Number(process.env.PORT);
const realFetch = globalThis.fetch;
// Every Penfield host goes to the fixture over plain http on localhost.
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
	const u = new URL(String(input instanceof Request ? input.url : input));
	if (u.hostname.endsWith(".penfield.app")) return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
	return realFetch(input, init);
}) as typeof fetch;

if (process.env.LOGOUT_AT) {
	const wait = Number(process.env.LOGOUT_AT) - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	console.log(JSON.stringify({ pid: process.pid, loggedOut: await deleteTokenStore(String(process.env.STORE)) }));
	process.exit(0);
}

const tm = new TokenManager({
	env: "dev",
	mcpUrl: "https://mcp-dev.penfield.app/",
	apiBase: "https://api-dev.penfield.app",
	authBase: "https://auth-dev.penfield.app",
	authMode: "deviceCode",
	tokenStorePath: String(process.env.STORE),
	scope: "read write offline_access",
});

for (const at of String(process.env.AT_TIMES ?? "0")
	.split(",")
	.map(Number)) {
	const wait = at - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	try {
		console.log(JSON.stringify({ pid: process.pid, token: await tm.getAccessToken() }));
	} catch (error) {
		console.log(JSON.stringify({ pid: process.pid, error: (error as Error).message }));
	}
}
