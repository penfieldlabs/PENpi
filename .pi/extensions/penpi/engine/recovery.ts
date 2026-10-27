import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { type AgentMessage, messageTokens, parseOverflow } from "./estimator.ts";
import {
	CONTINUE_TYPE,
	HEADER_FORMAT,
	LENGTH_CONTINUATION,
	REASONING_ONLY_CONTINUATION,
	STATE_TYPE,
} from "./options.ts";

// ================================================================== provider error classes (G1)

/**
 * G1: what a provider error means for the engine.
 *   output-limit            the request asked for more output than the model may produce
 *   context-overflow        the input alone does not fit the context (E5: the window shrinks)
 *   combined-output-caused  input + requested output exceed the context, but the input alone fits
 *                           with room to answer: lower the output, never the window
 *   unknown                 anything else (rate limits, parameter errors, ...)
 */
export type ProviderErrorClass = "output-limit" | "context-overflow" | "combined-output-caused" | "unknown";

export interface ProviderErrorInfo {
	class: ProviderErrorClass;
	/** Which rule matched. */
	rule: string;
	/** The model's output ceiling, when the error states it. */
	outputLimit?: number;
	/** Output tokens the rejected request asked for, when stated. */
	requestedOutput?: number;
	/** Input tokens the provider counted, when stated. */
	input?: number;
	/** The context window the error states. */
	contextLimit?: number;
}

/** A combined error is output-caused only if the input leaves at least this much room to answer. */
export const MIN_OUTPUT_ROOM = 1_024;

export const toNumber = (text: string | undefined): number | undefined =>
	text === undefined ? undefined : Number(text.replace(/,/g, ""));

export const RATE_LIMIT_PATTERN = /rate.?limit|tokens per min|\(TPM\)|requests per min|too many requests|throttl/i;

export const OUTPUT_LIMIT_RULES: Array<{
	rule: string;
	pattern: RegExp;
	read: (m: RegExpMatchArray) => Partial<ProviderErrorInfo>;
}> = [
	{
		// Anthropic direct, Vertex and Bedrock InvokeModel (Anthropic body).
		rule: "anthropic max_tokens > maximum",
		pattern: /max_tokens:\s*([\d,]+)\s*>\s*([\d,]+),?\s*which is the maximum allowed number of output tokens/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), outputLimit: toNumber(m[2]) }),
	},
	{
		// OpenAI chat completions (max_tokens, and max_completion_tokens for reasoning models).
		rule: "openai is too large / supports at most",
		pattern:
			/(?:max_tokens|max_completion_tokens|max_output_tokens) is too large:\s*([\d,]+)\.?\s*This model supports at most ([\d,]+) completion tokens/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), outputLimit: toNumber(m[2]) }),
	},
	{
		// OpenAI parameter validation (Responses max_output_tokens).
		rule: "openai integer above maximum value",
		pattern:
			/'(?:max_tokens|max_completion_tokens|max_output_tokens)':\s*integer above maximum value\.\s*Expected a value <=\s*([\d,]+),\s*but got ([\d,]+)/i,
		read: (m) => ({ outputLimit: toNumber(m[1]), requestedOutput: toNumber(m[2]) }),
	},
	{
		// Bedrock Converse.
		rule: "bedrock exceeds the model limit",
		pattern: /maximum tokens you requested exceeds the model limit of ([\d,]+)/i,
		read: (m) => ({ outputLimit: toNumber(m[1]) }),
	},
	{
		// Gemini (Vertex and the Gemini API).
		rule: "gemini maxOutputTokens supported range",
		pattern:
			/maxOutputTokens value of ([\d,]+) but the supported range is from \d+ \(inclusive\) to ([\d,]+) \(exclusive\)/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), outputLimit: (toNumber(m[2]) ?? 1) - 1 }),
	},
];

export const COMBINED_RULES: Array<{
	rule: string;
	pattern: RegExp;
	read: (m: RegExpMatchArray) => { input?: number; requestedOutput?: number; contextLimit?: number };
}> = [
	{
		rule: "anthropic input + max_tokens > context limit",
		pattern: /input length and `?max_tokens`? exceed context limit:\s*([\d,]+)\s*\+\s*([\d,]+)\s*>\s*([\d,]+)/i,
		read: (m) => ({ input: toNumber(m[1]), requestedOutput: toNumber(m[2]), contextLimit: toNumber(m[3]) }),
	},
	{
		rule: "vllm max_tokens too large for the remaining context",
		pattern:
			/is too large:\s*([\d,]+)\.\s*This model's maximum context length is ([\d,]+) tokens and your request has ([\d,]+) input tokens/i,
		read: (m) => ({ requestedOutput: toNumber(m[1]), contextLimit: toNumber(m[2]), input: toNumber(m[3]) }),
	},
	{
		// OpenAI chat completions, OpenAI legacy completions, DeepSeek, vLLM <= 0.8, Groq-style.
		rule: "openai messages + completion > context",
		pattern:
			/maximum context length is ([\d,]+) tokens[.,]?\s*however,? you requested (?:about )?[\d,]+ tokens\s*\(([\d,]+) in (?:the messages|your prompt)[;,]\s*([\d,]+) (?:in|for) the completion\)/i,
		read: (m) => ({ contextLimit: toNumber(m[1]), input: toNumber(m[2]), requestedOutput: toNumber(m[3]) }),
	},
	{
		// OpenRouter: "(A of text input, T of tool input, B in the output)".
		rule: "openrouter input parts + output > context",
		pattern:
			/maximum context length is ([\d,]+) tokens\.?\s*however,? you requested about [\d,]+ tokens\s*\(([^)]*?)([\d,]+) in the output\)/i,
		read: (m) => ({
			contextLimit: toNumber(m[1]),
			input: [...m[2].matchAll(/([\d,]+) of [a-z ]*input/gi)].reduce(
				(sum, part) => sum + (toNumber(part[1]) ?? 0),
				0,
			),
			requestedOutput: toNumber(m[3]),
		}),
	},
	{
		// Hugging Face TGI (and Together AI deployments of it).
		rule: "tgi inputs + max_new_tokens",
		pattern:
			/`inputs` tokens \+ `max_new_tokens` must be <=\s*([\d,]+)\.\s*Given:\s*([\d,]+) `inputs` tokens and ([\d,]+) `max_new_tokens`/i,
		read: (m) => ({ contextLimit: toNumber(m[1]), input: toNumber(m[2]), requestedOutput: toNumber(m[3]) }),
	},
];

/** Output-limit wording without numbers (step down). Must not mention the context or the input. */
export const GENERIC_OUTPUT_LIMIT =
	/\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|max_new_tokens|max(?:imum)? tokens)\b[^.\n]{0,60}\b(?:too large|exceeds?|above|greater than|not less or equal|is limited)/i;

export const MENTIONS_INPUT = /context|input|prompt/i;

/**
 * G1: classify a provider error before relying on Pi's isContextOverflow, which reads several
 * combined (input + output) errors as overflow. Order: rate limits, explicit output limits,
 * combined errors (output-caused when the input alone fits with room), context overflow (the
 * engine's patterns and Pi's), output limits stated without numbers, unknown.
 */
export function classifyProviderError(errorMessage: string | undefined, provider?: string): ProviderErrorInfo {
	if (!errorMessage) return { class: "unknown", rule: "no message" };
	const text = errorMessage.replace(/[‘’]/g, "'");
	if (RATE_LIMIT_PATTERN.test(text)) return { class: "unknown", rule: "rate limit" };
	for (const { rule, pattern, read } of OUTPUT_LIMIT_RULES) {
		const match = text.match(pattern);
		if (match) return { class: "output-limit", rule, ...read(match) };
	}
	for (const { rule, pattern, read } of COMBINED_RULES) {
		const match = text.match(pattern);
		if (!match) continue;
		const parts = read(match);
		if (parts.input !== undefined && parts.contextLimit !== undefined) {
			const fits = parts.input + MIN_OUTPUT_ROOM <= parts.contextLimit;
			return { class: fits ? "combined-output-caused" : "context-overflow", rule, ...parts };
		}
	}
	const probe = {
		role: "assistant",
		stopReason: "error",
		errorMessage: text,
		provider,
		content: [],
	} as unknown as AssistantMessage;
	const { limit, requested } = parseOverflow(text);
	if (
		isContextOverflow(probe) ||
		/prompt is too long|input is too long|exceed(?:s|ed)? (?:the )?(?:maximum )?context/i.test(text)
	) {
		return { class: "context-overflow", rule: "context overflow", contextLimit: limit, input: requested };
	}
	if (GENERIC_OUTPUT_LIMIT.test(text) && !MENTIONS_INPUT.test(text)) {
		return { class: "output-limit", rule: "output limit without numbers" };
	}
	return { class: "unknown", rule: "no rule" };
}

// ================================================================== fault injection (D1)

/** When a fault fires: every Nth assistant response, at listed response numbers, or with a probability. */
export interface FaultRule {
	every?: number;
	at?: number[];
	probability?: number;
}

export interface FaultConfig {
	overflow?: FaultRule;
	outputLimit?: FaultRule;
	length?: FaultRule;
	seed?: number;
}

/** D1: fault-injection switch (JSON, or "overflow=every:7;output-limit=p:0.1;length=at:3,9;seed=42"). */
export const FAULTS_ENV = "PENPI_FAULTS";

/** D1: marks the deployment as production ("1", "true" or "yes"); fault injection is then refused. */
export const PRODUCTION_ENV = "PENPI_PRODUCTION";

export function parseFaultSpec(spec: string): FaultConfig {
	const trimmed = spec.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed) as FaultConfig;
	const config: FaultConfig = {};
	for (const part of trimmed.split(";").map((p) => p.trim())) {
		if (!part) continue;
		const [name, value = ""] = part.split("=").map((p) => p.trim());
		if (name === "seed") {
			config.seed = Number(value);
			continue;
		}
		const key = (
			{ overflow: "overflow", "output-limit": "outputLimit", output: "outputLimit", length: "length" } as const
		)[name as "overflow"];
		if (!key) throw new Error(`${FAULTS_ENV}: unknown fault "${name}" (overflow, output-limit, length)`);
		const [how, args = ""] = value.split(":");
		const rule: FaultRule = {};
		if (how === "every") rule.every = Number(args);
		else if (how === "at") rule.at = args.split(",").map(Number);
		else if (how === "p") rule.probability = Number(args);
		else throw new Error(`${FAULTS_ENV}: "${part}": use every:N, at:A,B or p:X`);
		config[key] = rule;
	}
	return config;
}

/** Deterministic generator for probabilistic faults. */
export function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

export function describeFaults(config: FaultConfig): string {
	const rule = (r: FaultRule) =>
		[
			r.every ? `every ${r.every}` : "",
			r.at?.length ? `at ${r.at.join(",")}` : "",
			r.probability ? `p ${r.probability}` : "",
		]
			.filter(Boolean)
			.join(" ");
	return [
		config.overflow ? `overflow ${rule(config.overflow)}` : "",
		config.outputLimit ? `output-limit ${rule(config.outputLimit)}` : "",
		config.length ? `length ${rule(config.length)}` : "",
		config.seed !== undefined ? `seed ${config.seed}` : "",
	]
		.filter(Boolean)
		.join("; ");
}

export function installRecovery(core: EngineCore): void {
	const { pi, opts, stats, log, pinOpts, st } = core;

	// ---------------------------------------------------------------- fault injection (D1)
	function faultFor(response: number): "overflow" | "output-limit" | "length" | undefined {
		if (!core.faults) return undefined;
		const fires = (rule: FaultRule | undefined) => {
			if (!rule) return false;
			if (rule.at?.includes(response)) return true;
			if (rule.every && rule.every > 0 && response % rule.every === 0) return true;
			return rule.probability !== undefined && rule.probability > 0 && st.faultRandom() < rule.probability;
		};
		if (fires(core.faults.overflow)) return "overflow";
		if (fires(core.faults.outputLimit)) return "output-limit";
		if (fires(core.faults.length)) return "length";
		return undefined;
	}

	/** D1: turn a successful response into an injected fault, loudly. Returns the replacement. */
	function injectFault(message: AssistantMessage, ctx: ExtensionContext): AssistantMessage | undefined {
		if (!core.faults) return undefined;
		st.responseCount++;
		const kind = faultFor(st.responseCount);
		if (!kind) return undefined;
		const limits = core.resolveLimits(ctx);
		const usage = message.usage;
		const input =
			usage.input + usage.cacheRead + usage.cacheWrite ||
			Math.round((st.lastSent?.estimate ?? 0) * core.ratioFor(limits.key));
		const tag = "[context-engine injected fault]";
		const noUsage = { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		let replacement: AssistantMessage;
		if (kind === "overflow") {
			const limit = Math.max(1_000, Math.floor(input * 0.9));
			replacement = {
				...message,
				content: [],
				stopReason: "error",
				errorMessage: `${tag} prompt is too long: ${input} tokens > ${limit} maximum`,
				usage: noUsage,
			};
		} else if (kind === "output-limit") {
			const sent = st.lastOutputLimit?.sent ?? limits.maxOutput;
			const outputCeiling = Math.max(opts.minOutputLimit, Math.floor(sent / 2));
			replacement = {
				...message,
				content: [],
				stopReason: "error",
				errorMessage: `${tag} max_tokens: ${sent} > ${outputCeiling}, which is the maximum allowed number of output tokens for ${message.model}`,
				usage: noUsage,
			};
		} else {
			// A length stop: the text is cut in half; Pi fails any tool call of a length-stopped message.
			const content = message.content.map((block) =>
				block.type === "text" ? { ...block, text: block.text.slice(0, Math.ceil(block.text.length / 2)) } : block,
			);
			replacement = { ...message, content, stopReason: "length" };
		}
		stats.faults.push({ response: st.responseCount, kind });
		const line = `FAULT INJECTED #${stats.faults.length} (${kind}) on response ${st.responseCount}: ${replacement.errorMessage ?? "stopReason length, text halved"}`;
		log(line);
		ctx.ui.notify(`context-engine: ${line}`, "warning");
		return replacement;
	}

	function onProviderError(message: AssistantMessage, ctx: ExtensionContext): ProviderErrorInfo {
		const info = classifyProviderError(message.errorMessage, message.provider);
		const limits = core.resolveLimits(ctx);
		let learned: string | undefined;
		if (info.class === "output-limit") learned = core.learnOutputCeiling(limits, info);
		else if (info.class === "combined-output-caused") learned = core.learnOutputRoom(limits, info);
		stats.providerErrors.push({ key: limits.key, class: info.class, rule: info.rule, learned });
		log(`provider error (${info.class}; ${info.rule}): "${message.errorMessage}"${learned ? ` -> ${learned}` : ""}`);
		return info;
	}

	// ---------------------------------------------------------------- calibration (E3, H1, H2, H3)
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "user") {
			core.recordSource(message as AgentMessage & { timestamp?: number });
			return undefined;
		}
		if (message.role !== "assistant") return undefined;
		let assistant = message as AssistantMessage;
		let replacement: AssistantMessage | undefined;
		if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
			replacement = injectFault(assistant, ctx);
			if (replacement) assistant = replacement;
		}
		if (assistant.stopReason === "error") onProviderError(assistant, ctx);
		else if (assistant.stopReason !== "aborted") core.calibrate(assistant, ctx);
		return replacement ? { message: replacement } : undefined;
	});

	pi.on("turn_end", (event, ctx) => {
		const drafts: SessionBoundaryDraft[] = [...event.entries];
		let shouldContinue = event.continue;
		core.reportPlateau(ctx, drafts);
		const message = event.message as AssistantMessage;
		if (message.role === "assistant" && message.stopReason === "length") {
			const hasToolCalls = message.content.some((block) => block.type === "toolCall");
			const limits = core.resolveLimits(ctx);
			const state = limits.state;
			const output = message.usage.output;
			const sent = st.lastOutputLimit?.sent;
			// H4: the stop hit the limit we asked for. If the engine lowered it, raise it for the retry.
			if (sent && output >= sent * 0.98 && st.lastOutputLimit?.lowered) {
				const raised = Math.min(
					Math.max(sent * 2, limits.maxOutput),
					Math.floor(limits.hardWindow / 2),
					state.output.ceiling ?? Number.POSITIVE_INFINITY,
				);
				if (raised > (state.output.raised ?? 0) && raised > sent) {
					state.output.raised = raised;
					stats.outputRaised.push({ key: limits.key, to: raised });
					drafts.push({ type: "custom", customType: STATE_TYPE, data: core.snapshot(limits.key) });
					log(`output: length stop at the engine's clamp ${sent}; raised to ${raised}`);
				}
			} else if (sent && output < sent * 0.98) {
				// The provider stopped below what we asked: a real output ceiling once it repeats.
				state.output.stops = [...state.output.stops.slice(-3), output];
				const same = state.output.stops.filter((x) => Math.abs(x - output) <= 0.02 * output);
				if (same.length >= 2 && state.output.ceiling !== Math.max(...same)) {
					state.output.ceiling = Math.max(...same);
					state.output.ceilingSource = "length";
					stats.outputCeilings.push({ key: limits.key, ceiling: state.output.ceiling });
					drafts.push({ type: "custom", customType: STATE_TYPE, data: core.snapshot(limits.key) });
					log(`output: provider ceiling learned at ${state.output.ceiling}`);
				}
			}
			if (hasToolCalls && state.output.ceiling && output >= state.output.ceiling * 0.98 && !st.hintedThisRun) {
				st.hintedThisRun = true;
				drafts.push({
					type: "custom_message",
					customType: CONTINUE_TYPE,
					content: `Your tool call was cut off at the provider's output limit (about ${state.output.ceiling} tokens per response) and was not executed. Retrying the same call will fail the same way: split the content into several smaller tool calls (for example, write the file in parts).`,
					display: false,
				});
			}
			// E6: length continuation for text answers, bounded (maxLengthContinuations per run).
			if (!hasToolCalls && st.lengthContinuations < opts.maxLengthContinuations) {
				st.lengthContinuations++;
				stats.lengthContinuations++;
				// D15: nothing visible was written and the reasoning is not replayed, so asking to continue it
				// makes the model reason again from scratch.
				const reasoningOnly = !message.content.some(
					(block) => block.type === "text" && block.text.trim().length > 0,
				);
				const direct = reasoningOnly && opts.reasoningOnlyContinuation === "answer";
				if (reasoningOnly) stats.reasoningOnlyStops++;
				log(
					`length stop: continuation ${st.lengthContinuations}/${opts.maxLengthContinuations}${reasoningOnly ? ` (reasoning only, ${direct ? "answer" : "continue"} message)` : ""}`,
				);
				drafts.push({
					type: "custom_message",
					customType: CONTINUE_TYPE,
					content: direct ? REASONING_ONLY_CONTINUATION : LENGTH_CONTINUATION,
					display: false,
				});
				shouldContinue = true;
			}
		}
		if (drafts.length === event.entries.length && shouldContinue === event.continue) return undefined;
		return { entries: drafts, continue: shouldContinue };
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const projection = event.context.contextEntries;
		// E5: the final attempt overflowed. Find it in the projection (Pi may already have omitted it).
		const lastAssistant = [...branch].reverse().find((e) => e.type === "message" && e.message.role === "assistant");
		const lastMessage = lastAssistant?.type === "message" ? (lastAssistant.message as AssistantMessage) : undefined;
		// G1: classify before relying on Pi's isContextOverflow (it reads some combined errors as overflow).
		const info =
			lastMessage?.stopReason === "error"
				? classifyProviderError(lastMessage.errorMessage, lastMessage.provider)
				: undefined;
		if (lastAssistant && (info?.class === "output-limit" || info?.class === "combined-output-caused")) {
			// The output was learned at message_end; retry with it, bounded, and never shrink the window.
			if (st.outputRetries >= opts.maxOutputRetries || !st.lastOutputProgress) {
				log(
					`output-limit retry stopped (${st.outputRetries}/${opts.maxOutputRetries} retries${st.lastOutputProgress ? "" : ", no lower output to try"})`,
				);
				return undefined;
			}
			st.outputRetries++;
			stats.outputRetries++;
			const drafts: SessionBoundaryDraft[] = [
				...event.entries,
				{ type: "custom", customType: STATE_TYPE, data: core.snapshot(core.resolveLimits(ctx).key) },
			];
			const alreadyOmitted = !projection.some((e) => e.sourceEntry.id === lastAssistant.id && e.messages.length > 0);
			if (!alreadyOmitted) drafts.push({ type: "context_edit", targetId: lastAssistant.id, replacement: null });
			log(`output-limit retry ${st.outputRetries}/${opts.maxOutputRetries} (${info.class})`);
			return { entries: drafts, continue: true };
		}
		const failed = info?.class === "context-overflow" ? lastAssistant : undefined;
		if (failed && failed.type === "message") {
			if (st.overflowRetries >= opts.maxOverflowRetries) {
				log("overflow retry budget exhausted");
				return undefined;
			}
			st.overflowRetries++;
			stats.overflowRetries++;
			const drafts: SessionBoundaryDraft[] = [...event.entries];
			core.learnFromOverflow(
				core.resolveLimits(ctx),
				(failed.message as AssistantMessage).errorMessage,
				drafts,
				info,
			);
			const alreadyOmitted = !projection.some((e) => e.sourceEntry.id === failed.id && e.messages.length > 0);
			if (!alreadyOmitted) drafts.push({ type: "context_edit", targetId: failed.id, replacement: null });
			return { entries: drafts, continue: true };
		}
		return undefined;
	});

	pi.on("agent_settled", () => {
		// Every input of the run has become a message (or was handled); nothing stale is matched later.
		st.pendingInputs = [];
		st.lengthContinuations = 0;
		st.hintedThisRun = false;
		st.outputRetries = 0;
		st.lastOutputProgress = true;
	});

	// --------------------------------------------------------------- E1
	pi.on("session_before_compact", (event, ctx) => {
		stats.cancelledCompactions[event.reason] = (stats.cancelledCompactions[event.reason] ?? 0) + 1;
		if (event.reason !== "manual") return { cancel: true };
		// Manual /compact advances the window. No model call.
		const limits = core.resolveLimits(ctx);
		const ratio = core.ratioFor(limits.key);
		const branch = ctx.sessionManager.getBranch();
		const projection = ctx.sessionManager.buildSessionProjection();
		const { slots } = core.buildSlots(projection.entries, limits, ratio);
		const cut = core.readCut(branch);
		const start = cut
			? Math.max(
					0,
					slots.findIndex((s) => s.entryId === cut.firstKeptEntryId),
				)
			: 0;
		// F2: measured with the sections this cut puts into effect (E8.14), as the request path does: the
		// pending ones with this session's earlier ones, else the latest cut's.
		const systems = projection.messages.filter((m) => m.role === "system") as AgentMessage[];
		const preview = core.sectionsAtCut(false);
		const system = core.systemWith(systems, preview ? { sections: preview } : cut);
		const systemTokens = system ? messageTokens(system as AgentMessage) : 0;
		// With the pin on, the current cut's header is known exactly (no cut yet: the bound).
		const fixed =
			systemTokens + (pinOpts && cut ? messageTokens(core.headerMessage(cut.header)) : core.headerTokens(branch));
		const current = (fixed + core.suffixSums(slots)[start]) * ratio;
		const seq = (cut?.seq ?? 0) + 1;
		const plan = core.chooseCut(
			branch,
			seq,
			systemTokens,
			(f) => core.chooseStart(slots, start, f, Math.min(opts.lowWater * limits.budget, current * 0.5), ratio, true),
			(s) => slots[s]?.entryId,
		);
		const next = plan.start;
		if (next > start) {
			const header = plan.header ?? core.makeHeader(seq, slots[next].entryId, branch);
			// Pending system prompt sections take effect at this cut too (E8.14); the rebuilt window applies them.
			const sections = core.sectionsAtCut(true);
			pi.appendEntry(STATE_TYPE, {
				kind: "cut",
				firstKeptEntryId: slots[next].entryId,
				seq,
				header,
				hv: HEADER_FORMAT,
				...core.cutSectionsRecord(branch, sections),
			});
			core.logPin(header, seq);
			stats.cuts.push({ seq, mode: opts.mode, where: "manual", omitted: next, before: current, after: 0 });
			st.index = undefined;
			ctx.ui.notify(`Context window advanced (window #${seq}); nothing was summarized.`, "info");
		}
		return { cancel: true };
	});
}
