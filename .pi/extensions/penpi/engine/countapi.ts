/**
 * 0.9.0: the provider count APIs (design section 6), the exact path for a family with no public tokenizer, on a direct
 * key: Claude's `count_tokens` (Anthropic's own API). OpenRouter, the cloud platforms, a login and offline stay on the
 * fallback path.
 *
 * - **The setting:** `countApi` "auto" (default) or "off". "off" keeps every sample on the fallback rules.
 * - **What is counted:** the payload as the engine's `before_provider_request` handler sees it, sent to the provider
 *   that gets the request, so no new party sees anything. A payload with an output limit of 1 (the cache warmer) is
 *   never counted. A payload is counted only when it matches the planned request, compared in one shape: the planned
 *   request's last message (its text, or its tool results' ids) found at the payload's end.
 * - **Which requests:** an append-only request, or one whose expected size is within COUNT_API_BAND of the largest
 *   usage reported; above COUNT_API_BIG_BODY of body, only those near the largest usage, and the request before each,
 *   which its delta needs, counted when the band request is. Every other sample is a fallback sample.
 * - **The call** runs beside the request, never awaited before it and never retried, with a COUNT_API_TIMEOUT_MS
 *   timeout. A count still out when the sample is judged makes it a fallback sample. A timeout on a body over
 *   COUNT_API_BIG_BODY is late, not a failure.
 * - **A 429** on the count pauses counting for its Retry-After, or COUNT_API_PAUSE_MS. A 429 is never evidence: the
 *   request's own has no usage, and the count's samples are fallback samples.
 * - **Other failures:** COUNT_API_FAILURES in a row turn the count API off for the session, with one notice naming
 *   the reason (a refused beta among them).
 * - **Claude:** the body without the output fields, `max_tokens` among them, and never a `thread` field; the request's
 *   betas as the `anthropic-beta` header. A response served by another model than the one asked for, or by an unnamed
 *   model when the request names fallbacks, is a fallback sample.
 * - **Detection:** a counted sample is an exact sample (detector.ts judgeExact): its count is the request's whole
 *   rendered size and its text count, with COUNT_API_TOLERANCE a request.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import type { AgentMessage } from "./estimator.ts";
import type { ExactRequest } from "./exact.ts";

/** The count's tolerance, a request: the counts matched billed input exactly, but the docs call them an estimate. */
export const COUNT_API_TOLERANCE = 4;
/** The count's time limit. */
export const COUNT_API_TIMEOUT_MS = 2_000;
/** The pause after a 429 on a count with no Retry-After. */
export const COUNT_API_PAUSE_MS = 60_000;
/** Failures in a row that turn the count API off for the session. */
export const COUNT_API_FAILURES = 3;
/** Above this body size only the requests near the largest usage, and the one before each, are counted. */
export const COUNT_API_BIG_BODY = 1_000_000;
/** A request is near the largest usage when its expected size is within this share of it. */
export const COUNT_API_BAND = 0.15;
export type CountApiKind = "claude";

/** Where a model's count goes: its endpoint and the headers that carry the key. */
export interface CountTarget {
	kind: CountApiKind;
	url: string;
	headers: Record<string, string>;
}

/** The planned request's end, which the payload must show (planner.ts): its text, or its tool results. */
export interface PlannedTail {
	text?: string;
	toolIds: string[];
	toolNames: string[];
}

/** What the planner appended, for the count path's tolerance (planner.ts lastSent.appendedCounts). */
export interface AppendedCounts {
	messages: number;
	calls: number;
	args: number;
}

/** A count's slot on its request (lastSent.count). */
export interface CountSlot {
	kind: CountApiKind;
	/** The model asked for, and whether the request names fallback models. */
	model: string;
	fallbacksNamed: boolean;
	bytes: number;
	/** The count, once it settles; or why there is none. */
	total?: number;
	failed?: string;
	/** Why this request isn't counted, when it isn't. */
	skipped?: string;
	/** The model the response says served it. */
	served?: string;
	/** Settled after the sample was judged. */
	late?: boolean;
	judged?: boolean;
}

/** What detection reads of a counted sample (lastSent.countApi). */
export interface CountedSample {
	kind: CountApiKind;
}

export interface CountApiStats {
	/** Count calls made, and those that came back with a count. */
	calls: number;
	counted: number;
	/** Failures, 429s, and counts still out when their sample was judged (or timed out on a big body). */
	failures: number;
	rateLimited: number;
	late: number;
	/** Requests not counted, by reason. */
	skipped: Record<string, number>;
	/** Why the count API was turned off for the session, when it was. */
	off?: string;
}

export function newCountApiStats(): CountApiStats {
	return { calls: 0, counted: 0, failures: 0, rateLimited: 0, late: 0, skipped: {} };
}

/** The count API's side of the engine core. */
export interface CountApi {
	/** Joins a settled count to its sample, before the detector judges it. */
	apply: (sent: NonNullable<EngineCore["st"]["lastSent"]>) => void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const hostOf = (url: string | undefined): string | undefined => {
	try {
		return url ? new URL(url).host : undefined;
	} catch {
		return undefined;
	}
};

/** The planned request's end (planner.ts): the trailing tool results' ids and names, or the last message's text. */
export function plannedTail(messages: AgentMessage[]): PlannedTail {
	const tail: PlannedTail = { toolIds: [], toolNames: [] };
	let i = messages.length - 1;
	while (i >= 0 && messages[i].role === "toolResult") {
		const m = messages[i] as { toolCallId?: string; toolName?: string };
		tail.toolIds.unshift(m.toolCallId ?? "");
		tail.toolNames.unshift(m.toolName ?? "");
		i--;
	}
	if (tail.toolIds.length > 0) return tail;
	const last = messages.at(-1) as { content?: unknown } | undefined;
	if (last) tail.text = textOf(last.content);
	return tail;
}

/** The tool calls and their arguments among `messages`, and how many there are. */
export function appendedCounts(messages: AgentMessage[]): AppendedCounts {
	const counts: AppendedCounts = { messages: messages.length, calls: 0, args: 0 };
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<{ type: string; arguments?: unknown }>) {
			if (b.type !== "toolCall") continue;
			counts.calls++;
			counts.args += isObject(b.arguments) ? Object.keys(b.arguments).length : 0;
		}
	}
	return counts;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: unknown }>)
		.filter((b) => (b.type === undefined || b.type === "text") && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("")
		.trim();
}

/** The payload's end, in the planned tail's shape: Anthropic's messages. */
export function payloadTail(_kind: CountApiKind, payload: Json): PlannedTail | undefined {
	const tail: PlannedTail = { toolIds: [], toolNames: [] };
	const messages = payload.messages;
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	const last = messages.at(-1) as { content?: unknown };
	if (Array.isArray(last.content)) {
		for (const b of last.content as Array<{ type?: string; tool_use_id?: string }>)
			if (b.type === "tool_result") tail.toolIds.push(b.tool_use_id ?? "");
	}
	if (tail.toolIds.length === 0) tail.text = textOf(last.content);
	return tail;
}

/** Whether the payload's end is the planned request's: the same text, or the same tool results (by id, else name). */
export function tailsMatch(planned: PlannedTail, found: PlannedTail | undefined): boolean {
	if (!found) return false;
	if (planned.toolIds.length > 0 || found.toolIds.length > 0) {
		if (planned.toolIds.length !== found.toolIds.length) return false;
		return found.toolIds.every((id, i) =>
			id ? id === planned.toolIds[i] : found.toolNames[i] === planned.toolNames[i],
		);
	}
	return (planned.text ?? "") === (found.text ?? "");
}

/** Whether a payload is the cache warmer's: an output limit of 1. */
export function isWarmPayload(payload: Json): boolean {
	return payload.max_tokens === 1;
}

/** Fields of a Messages request that `count_tokens` doesn't take, or that don't change the count. */
const CLAUDE_OUTPUT_FIELDS = [
	"max_tokens",
	"stream",
	"metadata",
	"temperature",
	"top_p",
	"top_k",
	"stop_sequences",
	"service_tier",
	"thread",
	"betas",
	"fallbacks",
];

/** The count's body and extra headers, from the payload at the engine's handler. */
export function countBody(
	_kind: CountApiKind,
	payload: Json,
	_model: string,
): { body: Json; headers: Record<string, string> } {
	const body: Json = {};
	for (const [k, v] of Object.entries(payload)) if (!CLAUDE_OUTPUT_FIELDS.includes(k)) body[k] = v;
	const betas = Array.isArray(payload.betas) ? (payload.betas as unknown[]).filter((b) => typeof b === "string") : [];
	return { body, headers: betas.length ? { "anthropic-beta": betas.join(",") } : {} };
}

/** The count in a count API's answer. */
function totalOf(kind: CountApiKind, answer: unknown): number | undefined {
	const n = isObject(answer) && kind === "claude" ? answer.input_tokens : undefined;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The parts of Pi's model registry the direct-key check reads. */
export interface CountRegistry {
	isUsingOAuth: (model: Model<Api>) => boolean;
	getProviderAuth: (provider: string) => Promise<{ auth: { apiKey?: string; baseUrl?: string } } | undefined>;
}

/**
 * Where a model's count goes on a direct key: Anthropic's own API with an API key, not a login (OAuth), OpenRouter, a
 * cloud platform or a proxy at another address. Undefined for every other route.
 */
export async function directCountTarget(
	model: Model<Api>,
	registry: CountRegistry | undefined,
): Promise<CountTarget | undefined> {
	const host = "api.anthropic.com";
	if (model.api !== "anthropic-messages" || model.provider !== "anthropic" || hostOf(model.baseUrl) !== host)
		return undefined;
	if (!registry || registry.isUsingOAuth(model)) return undefined;
	const auth = (await registry.getProviderAuth(model.provider).catch(() => undefined))?.auth;
	if (!auth?.apiKey || (auth.baseUrl && hostOf(auth.baseUrl) !== host)) return undefined;
	const base = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
	return {
		kind: "claude",
		url: `${base}/v1/messages/count_tokens`,
		headers: { "x-api-key": auth.apiKey, "anthropic-version": "2023-06-01" },
	};
}

export function installCountApi(core: EngineCore): void {
	const { pi, opts, log, st, stats } = core;
	const fetchFn = opts.countApiFetch ?? globalThis.fetch;
	let failures = 0;
	let pausedUntil = 0;
	let off: string | undefined;
	let notifyCtx: ExtensionContext | undefined;
	/** The last request's count body, kept above COUNT_API_BIG_BODY in case the next one needs its delta. */
	let previous:
		| { seq: number; key: string; target: CountTarget; body: Json; headers: Record<string, string>; slot: CountSlot }
		| undefined;

	const skip = (slot: CountSlot | undefined, reason: string) => {
		if (slot) slot.skipped = reason;
		stats.countApi.skipped[reason] = (stats.countApi.skipped[reason] ?? 0) + 1;
	};

	function turnOff(reason: string): void {
		if (off) return;
		off = reason;
		stats.countApi.off = reason;
		log(`count API off for this session: ${reason}`);
		// The count settles beside the request: the session may have ended by then, and its context with it.
		try {
			notifyCtx?.ui.notify(
				`context-engine: the provider's count API is off for this session (${reason}); detection is on the estimate`,
				"warning",
			);
		} catch {}
	}

	/** Where this model's count goes, on a direct key only; undefined for every other route. */
	async function target(ctx: ExtensionContext): Promise<CountTarget | undefined> {
		const model = ctx.model;
		if (!model) return undefined;
		if (opts.countApiTarget) return opts.countApiTarget(`${model.provider}/${model.id}`);
		return directCountTarget(model, ctx.modelRegistry);
	}

	/** One count, beside its request: settles `slot` (or calls `done` with the total), never throws. */
	async function count(
		t: CountTarget,
		body: Json,
		headers: Record<string, string>,
		slot: CountSlot,
		done?: (total: number) => void,
	): Promise<void> {
		stats.countApi.calls++;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), opts.countApiTimeoutMs ?? COUNT_API_TIMEOUT_MS);
		(timer as { unref?: () => void }).unref?.();
		try {
			const response = await fetchFn(t.url, {
				method: "POST",
				headers: { "content-type": "application/json", ...t.headers, ...headers },
				body: JSON.stringify(body),
				signal: abort.signal,
			});
			if (response.status === 429) {
				const after = Number(response.headers.get("retry-after"));
				pausedUntil = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : COUNT_API_PAUSE_MS);
				stats.countApi.rateLimited++;
				slot.failed = "429";
				log(`count API: 429, counting paused for ${Math.round((pausedUntil - Date.now()) / 1000)} s`);
				return;
			}
			const text = await response.text();
			if (!response.ok) {
				let reason = `${response.status}`;
				try {
					const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
					if (message) reason += `: ${message}`;
				} catch {}
				throw new Error(reason);
			}
			const total = totalOf(t.kind, JSON.parse(text));
			if (total === undefined) throw new Error("no count in the answer");
			failures = 0;
			stats.countApi.counted++;
			if (slot.judged) {
				slot.late = true;
				return;
			}
			slot.total = total;
			done?.(total);
		} catch (error) {
			const reason = abort.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
			slot.failed = reason;
			// A big body on a slow link is late, not failing: it must not turn the count off where the late case lives.
			if (abort.signal.aborted && slot.bytes > COUNT_API_BIG_BODY) {
				stats.countApi.late++;
				return;
			}
			stats.countApi.failures++;
			failures++;
			log(`count API failure ${failures}/${COUNT_API_FAILURES}: ${reason}`);
			if (failures >= COUNT_API_FAILURES) turnOff(reason);
		} finally {
			clearTimeout(timer);
		}
	}

	pi.on("before_provider_request", (event, ctx) => {
		if ((opts.countApi ?? "auto") === "off" || off) return undefined;
		const payload = event.payload;
		const sent = st.lastSent;
		if (!isObject(payload) || !sent || sent.count) return undefined;
		if (isWarmPayload(payload)) return undefined;
		notifyCtx = ctx;
		const planned = sent.plannedTail;
		const state = core.modelState(sent.key);
		const expected = sent.estimate * core.ratioFor(sent.key);
		const nearMax = state.maxReported > 0 && expected >= (1 - COUNT_API_BAND) * state.maxReported;
		const model = ctx.model?.id ?? "";
		// The count's own work starts after the hook returns: it never holds up the request.
		void target(ctx).then((t) => {
			if (!t || st.lastSent !== sent || sent.count) return;
			const { body, headers } = countBody(t.kind, payload, model);
			const bytes = Buffer.byteLength(JSON.stringify(body));
			const slot: CountSlot = {
				kind: t.kind,
				model,
				fallbacksNamed: Array.isArray(payload.fallbacks) && payload.fallbacks.length > 0,
				bytes,
			};
			sent.count = slot;
			const keep =
				bytes > COUNT_API_BIG_BODY ? { seq: sent.seq, key: sent.key, target: t, body, headers, slot } : undefined;
			const before = previous;
			previous = keep;
			if (!planned || !tailsMatch(planned, payloadTail(t.kind, payload)))
				return skip(slot, "the payload doesn't match the planned request");
			if (Date.now() < pausedUntil) return skip(slot, "paused after a 429");
			if (!sent.appendOnly && !nearMax) return skip(slot, "not append-only, and not near the largest usage");
			if (bytes > COUNT_API_BIG_BODY && !nearMax) return skip(slot, "a body over 1 MB, not near the largest usage");
			void count(t, body, headers, slot);
			// The delta needs the request before: above 1 MB it wasn't counted, so it is counted now.
			if (
				bytes > COUNT_API_BIG_BODY &&
				before &&
				before.seq === sent.seq - 1 &&
				before.key === sent.key &&
				before.slot.total === undefined &&
				(before.slot.served === undefined || before.slot.served === before.slot.model)
			) {
				const earlier = { ...before.slot, judged: false, failed: undefined, skipped: undefined };
				void count(before.target, before.body, before.headers, earlier, (total) => {
					const last = core.modelState(before.key).lastSample;
					if (last && last.seq === before.seq && last.exactRendered === undefined) last.exactRendered = total;
				});
			}
		});
		return undefined;
	});

	// A 429 on the request is never evidence: its sample, if any, isn't counted.
	pi.on("after_provider_response", (event) => {
		const slot = st.lastSent?.count;
		if (event.status === 429 && slot && !slot.skipped) skip(slot, "the request got a 429");
	});

	// Claude: the served model, from the stream's message_start.
	pi.on("provider_stream_event", (event) => {
		const data = event.data as { type?: string; message?: { model?: unknown } } | undefined;
		const slot = st.lastSent?.count;
		if (slot && data?.type === "message_start" && typeof data.message?.model === "string")
			slot.served = data.message.model;
	});

	core.countApi = {
		apply(sent) {
			const slot = sent.count;
			if (!slot) return;
			slot.judged = true;
			if (slot.skipped) return;
			if (slot.total === undefined) {
				if (!slot.failed) {
					stats.countApi.late++;
					log("count API: the count was still out when the sample was judged; a fallback sample");
				}
				return;
			}
			if (slot.served !== undefined && slot.served !== slot.model)
				return void log(`count API: served by ${slot.served}, not ${slot.model}; a fallback sample`);
			if (slot.served === undefined && slot.fallbacksNamed)
				return void log(
					"count API: the request names fallback models and the response names none; a fallback sample",
				);
			const counts = sent.appendedCounts ?? { messages: 0, calls: 0, args: 0 };
			const request: ExactRequest = {
				rendered: slot.total,
				text: slot.total,
				band: 0,
				appendedMessages: counts.messages,
				appendedBand: 0,
				// Claude counts images as it bills them.
				appendedImages: false,
				appendedCalls: counts.calls,
				appendedArguments: counts.args,
			};
			sent.exactRequest = request;
			sent.exact = slot.total;
			sent.exactKey = `${sent.key}#count-api`;
			sent.exactAssumed = false;
			sent.exactEntry = undefined;
			sent.exactTemplate = undefined;
			sent.countApi = { kind: slot.kind };
		},
	};
}
