/**
 * A real Streamable-HTTP MCP server standing in for Penfield, for the
 * cross-package integration test.
 *
 * Why HTTP and not stdio: the entry PENpi's `session_start` writes is a URL
 * entry (`url` + `auth: "bearer"` + `bearerTokenEnv`). The integration test is
 * required to use the entry PENpi actually generates, unmodified — so the
 * fixture has to be reachable the way a real Penfield deployment is. The test
 * redirects the TCP connection for that origin at the dispatcher level; nothing
 * about the entry, the adapter, or PENpi is altered.
 *
 * Built on the MCP SDK's own server transport (stateless mode: one server +
 * transport per request) so the wire protocol is the SDK's, not a hand-rolled
 * approximation of it. A hand-written server would only prove that the client
 * agrees with my guess about the protocol.
 *
 * Exposes the five tools PENpi and its conscious layer actually use:
 * `awaken` and `reflect` (PENpi's own orientation path), `save_context`, and
 * `recall`/`store` (the direct tools the adapter must register).
 */
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The briefing `awaken` returns, so the test can prove it reached the model's context. */
export const FIXTURE_BRIEFING = "PENpi integration fixture briefing.";
/** The text `reflect` returns. */
export const FIXTURE_REFLECTION = "PENpi integration fixture reflection.";

const OBJECT_SCHEMA = { type: "object", properties: {}, additionalProperties: true } as const;

const TOOLS = [
	{ name: "awaken", description: "Load personality and preferences.", inputSchema: OBJECT_SCHEMA },
	{ name: "reflect", description: "Reflect over a time window.", inputSchema: OBJECT_SCHEMA },
	{ name: "save_context", description: "Save a cognitive checkpoint.", inputSchema: OBJECT_SCHEMA },
	{ name: "recall", description: "Recall from Penfield.", inputSchema: OBJECT_SCHEMA },
	{ name: "store", description: "Store to Penfield.", inputSchema: OBJECT_SCHEMA },
];

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function makeServer(): Server {
	const server = new Server({ name: "penfield-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		switch (request.params.name) {
			// awaken() returns JSON so PENpi's extractBriefing() takes the structured
			// `briefing` field rather than falling back to raw text.
			case "awaken":
				return text({ briefing: FIXTURE_BRIEFING });
			case "reflect":
				return text(FIXTURE_REFLECTION);
			default:
				return text(`${request.params.name}: ok`);
		}
	});
	return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface FixturePenfield {
	/** Origin the fixture is actually listening on (127.0.0.1). */
	port: number;
	/** Every `Authorization` header the fixture has been sent, in order. */
	authorizations: string[];
	/** Every rejected `Authorization` header, so a test can assert none occurred. */
	rejected: string[];
	close(): Promise<void>;
}

/**
 * Start the fixture on an ephemeral loopback port.
 *
 * `expectedToken` is enforced, not merely recorded: any JSON-RPC request whose
 * bearer does not match gets a 401 and reaches no tool. That is what makes tool
 * registration itself evidence about auth. Recording headers alone would not —
 * PENpi's own MCP client and the adapter both talk to this server with the same
 * token, so "the right bearer appeared at some point" can be satisfied entirely
 * by PENpi's traffic while the adapter sends something else.
 */
export async function startFixturePenfield(expectedToken: string): Promise<FixturePenfield> {
	const authorizations: string[] = [];
	const rejected: string[] = [];

	const http: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		// Stateless Streamable HTTP: only POST carries JSON-RPC. Clients treat 405
		// on GET/DELETE as "this server has no standalone stream", which is correct.
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST" }).end();
			return;
		}

		const auth = req.headers.authorization ?? "";
		authorizations.push(auth);
		if (auth !== `Bearer ${expectedToken}`) {
			rejected.push(auth);
			// `WWW-Authenticate` without a resource-metadata URL: clients see a plain
			// 401 and fail, rather than starting an OAuth discovery detour that would
			// turn an auth defect into a timeout.
			res.writeHead(401, { "www-authenticate": "Bearer", "content-type": "text/plain" }).end("unauthorized");
			return;
		}

		try {
			const body = await readBody(req);
			const server = makeServer();
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => {
				void transport.close();
				void server.close();
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (err) {
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
			res.end(err instanceof Error ? err.message : String(err));
		}
	});

	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const port = (http.address() as AddressInfo).port;

	return {
		port,
		authorizations,
		rejected,
		close: () =>
			new Promise<void>((resolve, reject) => {
				http.closeAllConnections();
				http.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
