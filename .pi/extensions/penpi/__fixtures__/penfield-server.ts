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

async function readRaw(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const raw = await readRaw(req);
	return raw === "" ? undefined : JSON.parse(raw);
}

export interface FixturePenfield {
	/** Origin the fixture is actually listening on (127.0.0.1). */
	port: number;
	/** Every `Authorization` header the fixture has been sent, in order. */
	authorizations: string[];
	/** Every rejected `Authorization` header, so a test can assert none occurred. */
	rejected: string[];
	/** Each refresh token the OAuth token endpoint was given (0.6.0: a start with an expired access token). */
	refreshes: string[];
	/** The `clientInfo.name` of every accepted `initialize` request: which MCP clients connected, and how often. */
	initializations: string[];
	/** The client capabilities each accepted `initialize` offered, by `clientInfo.name`, in order. */
	capabilities: Array<{ client: string; capabilities: Record<string, unknown> }>;
	/** Every accepted request body that carries a `file://` URI (a root, or any local path): none is expected. */
	fileUris: string[];
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
	const initializations: string[] = [];
	const capabilities: Array<{ client: string; capabilities: Record<string, unknown> }> = [];
	const fileUris: string[] = [];
	const refreshes: string[] = [];

	const http: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		// OAuth, for PenfieldClient's refresh of an expired access token: the protected-resource and
		// authorization-server metadata, and a token endpoint that issues `expectedToken` (0.6.0).
		const path = (req.url ?? "").split("?")[0] ?? "";
		const json = (body: unknown) =>
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (path.startsWith("/.well-known/oauth-protected-resource")) {
			json({ authorization_servers: ["https://auth-dev.penfield.app"] });
			return;
		}
		if (path.startsWith("/.well-known/oauth-authorization-server")) {
			json({
				device_authorization_endpoint: "https://auth-dev.penfield.app/device",
				token_endpoint: "https://auth-dev.penfield.app/token",
				registration_endpoint: "https://auth-dev.penfield.app/register",
			});
			return;
		}
		if (path === "/token" && req.method === "POST") {
			const form = new URLSearchParams(String(await readRaw(req)));
			refreshes.push(form.get("refresh_token") ?? "");
			json({ access_token: expectedToken, expires_in: 3600, refresh_token: "fixture-refresh-next" });
			return;
		}

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
			const message = body as
				| { method?: unknown; params?: { clientInfo?: { name?: unknown }; capabilities?: Record<string, unknown> } }
				| undefined;
			if (message?.method === "initialize") {
				initializations.push(String(message.params?.clientInfo?.name));
				capabilities.push({
					client: String(message.params?.clientInfo?.name),
					capabilities: message.params?.capabilities ?? {},
				});
			}
			const raw = JSON.stringify(body ?? null);
			if (raw.includes("file://")) fileUris.push(raw);
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
		initializations,
		capabilities,
		fileUris,
		refreshes,
		close: () =>
			new Promise<void>((resolve, reject) => {
				http.closeAllConnections();
				http.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
