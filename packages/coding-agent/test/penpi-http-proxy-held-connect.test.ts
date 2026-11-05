import http from "node:http";
import net from "node:net";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

function listen(server: net.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Server did not bind to a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
}

describe("http dispatcher behind a proxy that holds a CONNECT", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		undici.setGlobalDispatcher(originalDispatcher);
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
	});

	it("answers a request to another host while one CONNECT is held", async () => {
		// Host A: its CONNECT is held by the proxy and never answered.
		const heldOrigin = http.createServer((_request, response) => response.end("held"));
		const heldPort = await listen(heldOrigin);
		const origin = http.createServer((_request, response) => response.end("origin"));
		const originPort = await listen(origin);

		const heldSockets: net.Socket[] = [];
		const proxy = http.createServer();
		proxy.on("connect", (request: http.IncomingMessage, client: net.Socket) => {
			const port = Number(request.url?.split(":")[1]);
			if (port === heldPort) {
				heldSockets.push(client);
				return;
			}
			const upstream = net.connect(port, "127.0.0.1", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				client.pipe(upstream).pipe(client);
			});
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
		});
		const proxyPort = await listen(proxy);

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
		process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		const heldAbort = new AbortController();
		try {
			const held = undici
				.fetch(`http://127.0.0.1:${heldPort}/`, { signal: heldAbort.signal })
				.catch(() => "aborted");
			await expect.poll(() => heldSockets.length).toBe(1);

			const startedAt = Date.now();
			const answer = await Promise.race([
				undici.fetch(`http://127.0.0.1:${originPort}/`).then((response) => response.text()),
				new Promise<string>((resolve) => setTimeout(() => resolve("no answer within 3 s"), 3_000)),
			]);
			expect(answer).toBe("origin");
			expect(Date.now() - startedAt).toBeLessThan(3_000);

			heldAbort.abort();
			await held;
		} finally {
			heldAbort.abort();
			for (const socket of heldSockets) socket.destroy();
			await dispatcher.destroy();
			undici.setGlobalDispatcher(originalDispatcher);
			proxy.closeAllConnections();
			origin.closeAllConnections();
			heldOrigin.closeAllConnections();
			await Promise.all(
				[proxy, origin, heldOrigin].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
			);
		}
	});
});
