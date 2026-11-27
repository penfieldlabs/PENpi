/**
 * 0.9.0: E2's count API profiles (E2_COUNT_API), the engine's provider count path against the simulator, all local.
 * The engine is given a count target for the faux model and a fake count endpoint, which answers with the simulator's
 * own count of the request the body is (its rendered tokens), as a provider's count of the same request would.
 *
 * - **claude** (E2_COUNT_API=claude): an Anthropic Messages payload, and `count_tokens` answers.
 *   - E2_COUNT_PROFILE=exact (default): a small variable excess, within the tolerance (-2 to +2); a fallback model
 *     serving about one request in 43; a failure about one count in 37, never three in a row; a 429 about one in 41;
 *     and a late answer about one in 31.
 *   - E2_COUNT_PROFILE=constant: an excess of 40 on every count, beyond the tolerance: the gate must never set.
 * - **gemini** (E2_COUNT_API=gemini): a Gemini generateContent payload, and `countTokens` answers.
 *   - E2_COUNT_PROFILE=flash (default): counts exactly.
 *   - E2_COUNT_PROFILE=gemini4: tool calls carry a thoughtSignature and count 8 below billed each, and images count
 *     29 to 58 above it, varying by image (each the same in every count of it).
 *   Both with the faults of Claude's exact profile: failures, 429s and late answers.
 */
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { GEMINI_SIGNED_CALL_EXCESS, geminiHistory } from "../../../../../.pi/extensions/penpi/engine/countapi.ts";
import { anthropicPayload, geminiPayload } from "../context-engine/helpers.ts";
import type { SimCall } from "./provider-sim.ts";

export const COUNT_API = process.env.E2_COUNT_API as "claude" | "gemini" | undefined;
const PROFILE = (process.env.E2_COUNT_PROFILE ?? (COUNT_API === "gemini" ? "flash" : "exact")) as
	| "exact"
	| "constant"
	| "flash"
	| "gemini4";
/** The profiles with scattered faults. */
const FAULTS = PROFILE !== "constant";

/** The simulator's options for a count profile: the payload to send, and the served model to report. */
export function countSimOptions(): {
	payload?: (context: TranscriptContext) => Record<string, unknown>;
	streamData?: (index: number) => unknown;
	responseDelayMs?: number;
} {
	if (!COUNT_API) return {};
	if (COUNT_API === "gemini")
		return {
			payload: (context) => geminiPayload(context, { signed: PROFILE === "gemini4" }),
			responseDelayMs: 60,
		};
	return {
		payload: (context) => anthropicPayload(context),
		// A provider answers after its count does; a late answer (below) takes longer than this.
		responseDelayMs: 60,
		// A fallback model serves about one request in 43; the rest name the model asked for.
		streamData: (index) => ({
			type: "message_start",
			message: { model: PROFILE === "exact" && index % 43 === 42 ? "e2-fallback" : undefined },
		}),
	};
}

/** The engine's options for a count profile, for the faux model `faux/<model>`; the simulator's calls by reference. */
export function countEngineOptions(model: string, calls: () => SimCall[]): Record<string, unknown> {
	if (!COUNT_API) return {};
	let n = 0;
	const fake = (async (_url: string, init: RequestInit) => {
		const i = n++;
		const body = JSON.parse(String(init.body)) as {
			messages?: unknown;
			generateContentRequest?: { contents?: unknown[] };
		};
		if (FAULTS) {
			if (i % 41 === 40) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
			if (i % 37 === 36) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
			if (i % 31 === 30) await new Promise((resolve) => setTimeout(resolve, 1_500));
		}
		const gemini = COUNT_API === "gemini";
		const key = JSON.stringify(gemini ? body.generateContentRequest?.contents : body.messages);
		let call: SimCall | undefined;
		for (let k = 0; k < 200 && !call; k++) {
			call = calls().findLast((c) => JSON.stringify(gemini ? c.payload?.contents : c.payload?.messages) === key);
			if (!call) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (!call) return new Response(JSON.stringify({ error: { message: "unknown request" } }), { status: 400 });
		if (gemini) {
			const history = geminiHistory({ contents: body.generateContentRequest?.contents });
			const total =
				PROFILE === "gemini4"
					? call.input -
						GEMINI_SIGNED_CALL_EXCESS * history.signedCalls +
						Array.from({ length: history.images }, (_, k) => 29 + ((k * 7) % 30)).reduce((a, b) => a + b, 0)
					: call.input;
			return new Response(JSON.stringify({ totalTokens: total }), { status: 200 });
		}
		const excess = PROFILE === "constant" ? 40 : (i % 5) - 2;
		return new Response(JSON.stringify({ input_tokens: call.input + excess }), { status: 200 });
	}) as typeof fetch;
	const target =
		COUNT_API === "gemini"
			? { kind: "gemini", url: `https://count.e2.invalid/v1beta/models/${model}:countTokens`, headers: {} }
			: { kind: "claude", url: "https://count.e2.invalid/v1/messages/count_tokens", headers: {} };
	return {
		countApiTarget: (key: string) => (key === `faux/${model}` ? target : undefined),
		countApiFetch: fake,
	};
}
