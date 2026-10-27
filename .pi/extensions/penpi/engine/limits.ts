import type { ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { parseOverflow } from "./estimator.ts";
import { STATE_TYPE } from "./options.ts";
import { classifyProviderError, type ProviderErrorInfo } from "./recovery.ts";
import type { LearnedWindow, Limits } from "./state.ts";

export function installLimits(core: EngineCore): void {
	const { pi, opts, stats, log, st } = core;

	// ---------------------------------------------------------------- limits (E7, H3, H4)
	const perModel = { ...opts.limitOverrides, ...(opts.modelLimits ?? {}) };
	core.perModel = perModel;
	const ceiling = opts.windowCeiling && opts.windowCeiling > 0 ? opts.windowCeiling : undefined;
	core.ceiling = ceiling;

	function resolveLimits(ctx: ExtensionContext): Limits {
		const model = ctx.model;
		const key = model ? `${model.provider}/${model.id}` : "?";
		const state = core.modelState(key);
		const override = perModel[key];
		const converter = model ? (opts.serializeAs?.[key] ?? opts.serializeAs?.[String(model.api)]) : undefined;
		st.target = model
			? {
					api: String(model.api),
					provider: model.provider,
					modelId: model.id,
					thinkingAsText:
						(model as { compat?: { requiresThinkingAsText?: boolean } }).compat?.requiresThinkingAsText === true,
					...(converter ? { converter } : {}),
				}
			: undefined;
		st.replayIgnored = opts.replayedReasoning?.[key] === "ignored";
		st.targetKey = st.target
			? `${st.target.api}|${st.target.provider}|${st.target.modelId}|${st.target.thinkingAsText}|${st.target.converter ?? ""}|${st.replayIgnored}`
			: "";
		const registered = model ? ctx.modelRegistry.find(model.provider, model.id) : undefined;
		const declaredWindow = model && model.contextWindow > 0 ? model.contextWindow : 0;
		const declaredMax = model && model.maxTokens > 0 ? model.maxTokens : 0;
		const plausibleMax =
			declaredMax > 0 && declaredWindow > 0 && declaredMax <= opts.implausibleOutputFraction * declaredWindow;
		const verified = !!registered && declaredWindow > 0 && plausibleMax;
		// 1. What the model (or the user) says.
		let base: number;
		let reason: string;
		if (override?.contextWindow) {
			base = override.contextWindow;
			reason = "override";
		} else if (declaredWindow > 0 && registered) {
			base = declaredWindow;
			reason = verified ? "metadata" : "metadata(unverified)";
		} else if (declaredWindow > 0) {
			base = Math.min(declaredWindow, opts.defaultWindow);
			reason = "default(unregistered)";
		} else {
			base = opts.defaultWindow;
			reason = "default(missing)";
		}
		// 2. H8: the decided ceiling caps planning, unless a per-model override set the window explicitly.
		let planned = base;
		if (ceiling && !override?.contextWindow && base > ceiling) {
			planned = ceiling;
			reason = "ceiling";
		}
		// 3. Evidence: a learned (smaller) limit wins over both.
		let window = planned;
		let hardWindow = base;
		if (state.learned && state.learned.window < window) {
			window = state.learned.window;
			reason = `learned(${state.learned.source})`;
		}
		if (state.learned && state.learned.window < hardWindow) hardWindow = state.learned.window;
		// G1: an output-caused combined error bounds the room for output, never the planning window.
		if (state.output.contextLimit && state.output.contextLimit < hardWindow) hardWindow = state.output.contextLimit;
		// Output: override, plausible metadata, or the default (capped at half the planning window).
		let maxOutput: number;
		let maxOutputReason: string;
		if (override?.maxTokens) {
			maxOutput = override.maxTokens;
			maxOutputReason = "override";
		} else if (plausibleMax) {
			maxOutput = declaredMax;
			maxOutputReason = "metadata";
		} else {
			maxOutput = Math.min(opts.defaultMaxOutput, Math.floor(window / 2));
			maxOutputReason = declaredMax > 0 ? "default (declared max is implausible)" : "default (no declared max)";
		}
		if (state.output.raised && state.output.raised > maxOutput) {
			maxOutput = Math.min(state.output.raised, Math.floor(hardWindow / 2));
			maxOutputReason += " +raised after a clamp-caused length stop";
		}
		if (state.output.ceiling && state.output.ceiling < maxOutput) {
			maxOutput = state.output.ceiling;
			maxOutputReason +=
				state.output.ceilingSource === "error"
					? " +provider ceiling learned from an output-limit error"
					: " +provider ceiling learned from length stops";
		}
		const reserve = Math.min(maxOutput, Math.floor(window * opts.outputReserveFraction));
		const budget = window - reserve;
		st.lastWindow = window;
		st.lastKey = key;
		return {
			window,
			metadataWindow: planned,
			hardWindow,
			declaredWindow,
			declaredMax,
			maxOutput,
			maxOutputReason,
			reserve,
			budget,
			high: opts.highWater * budget,
			low: opts.lowWater * budget,
			maxUnit: opts.maxUnitFraction * budget,
			verified,
			plausibleMax,
			reason,
			source: reason,
			ceiling,
			key,
			state,
		};
	}
	core.resolveLimits = resolveLimits;

	function maxUnitTokens(limits: Limits): number {
		return opts.maxUnitFraction * limits.budget;
	}
	core.maxUnitTokens = maxUnitTokens;

	// ---------------------------------------------------------------- provider errors (G1)
	/** G1: learn the output ceiling: the stated number, else half of what was asked (bounded below). */
	function learnOutputCeiling(limits: Limits, info: ProviderErrorInfo): string {
		const state = limits.state;
		const sent = st.lastOutputLimit?.sent ?? info.requestedOutput ?? limits.maxOutput;
		let ceiling = info.outputLimit;
		let how = "stated";
		if (!ceiling || ceiling >= sent) {
			ceiling = Math.max(opts.minOutputLimit, Math.floor(sent / 2));
			how = "stepped down";
		}
		st.lastOutputProgress = ceiling < sent;
		if (!st.lastOutputProgress) return `no lower output to try (asked ${sent}, floor ${opts.minOutputLimit})`;
		state.output.ceiling = Math.min(state.output.ceiling ?? Number.POSITIVE_INFINITY, ceiling);
		state.output.ceilingSource = "error";
		if (state.output.raised && state.output.raised > state.output.ceiling) state.output.raised = undefined;
		stats.outputCeilings.push({ key: limits.key, ceiling: state.output.ceiling });
		core.persistModel(limits.key);
		return `output ceiling ${state.output.ceiling} (${how}; asked ${sent}); window unchanged at ${limits.window}`;
	}
	core.learnOutputCeiling = learnOutputCeiling;

	/** G1: input + output > context with the input fitting: bound the output room, recalibrate, keep the window. */
	function learnOutputRoom(limits: Limits, info: ProviderErrorInfo): string {
		const state = limits.state;
		const input = info.input ?? 0;
		const contextLimit = info.contextLimit ?? limits.hardWindow;
		if (
			opts.calibrate &&
			input > 0 &&
			st.lastSent &&
			st.lastSent.estimate > 0 &&
			input / st.lastSent.estimate > state.ratio
		) {
			state.ratio = core.clampRatio(input / st.lastSent.estimate);
		}
		if (contextLimit < (state.output.contextLimit ?? Number.POSITIVE_INFINITY))
			state.output.contextLimit = contextLimit;
		const room = contextLimit - input - 256;
		const sent = st.lastOutputLimit?.sent ?? info.requestedOutput ?? limits.maxOutput;
		st.lastOutputProgress = room >= 256 && room < sent;
		st.outputCapOnce = Math.max(256, room);
		core.persistModel(limits.key);
		return `context ${contextLimit} bounds output room; the retry asks at most ${st.outputCapOnce} (input ${input}); window unchanged at ${limits.window}`;
	}
	core.learnOutputRoom = learnOutputRoom;

	/** E5 + H3: learn from an overflow. Returns the new believed window. */
	function learnFromOverflow(
		limits: Limits,
		errorMessage: string | undefined,
		drafts: SessionBoundaryDraft[],
		info: ProviderErrorInfo = classifyProviderError(errorMessage),
	): number {
		const state = limits.state;
		// G1: a combined error that the input alone does not fit states the input part separately.
		const parsed = parseOverflow(errorMessage);
		const limit = info.contextLimit ?? parsed.limit;
		const requested = info.input ?? parsed.requested;
		if (opts.calibrate && requested && st.lastSent && requested / st.lastSent.estimate > state.ratio) {
			state.ratio = core.clampRatio(requested / st.lastSent.estimate);
		}
		const sent = requested ?? (st.lastSent ? st.lastSent.estimate * core.ratioFor(limits.key) : limits.window);
		let shrunk = limits.window;
		if (limit && limit < limits.window) shrunk = limit;
		else if (limit && !(opts.calibrate && requested)) {
			// The limit is not below our window, so our units are off and cannot be recalibrated: go below what we sent.
			shrunk = Math.min(
				limits.window,
				Math.floor((st.lastSent?.estimate ?? sent) * core.ratioFor(limits.key) * 0.85),
			);
		} else if (!limit && (sent >= 0.5 * limits.window || st.overflowRetries > 1)) {
			shrunk = Math.min(limits.window, Math.floor(sent * 0.85));
		}
		const learned = state.learned;
		if (shrunk < limits.window || (learned && learned.window > learned.base)) {
			const source: LearnedWindow["source"] = limit ? "parsed" : "unparsed";
			if (learned && Math.abs(Math.min(shrunk, limits.window) - learned.base) <= 0.05 * learned.base) {
				// A re-probe failed at the limit we already knew: one more confirmation, longer wait.
				learned.confirmations++;
				learned.probeAfter *= 2;
				learned.window = learned.base;
				learned.cleanNear = 0;
			} else {
				state.learned = {
					window: shrunk,
					base: shrunk,
					declared: limits.metadataWindow,
					source,
					confirmations: 0,
					cleanNear: 0,
					probeAfter: source === "parsed" ? opts.probeAfterParsed : opts.probeAfterUnparsed,
					evidenceAbove: limit && limit < limits.window ? limit : Math.round(sent),
				};
			}
			const now = state.learned!;
			stats.learnedWindows.push({
				key: limits.key,
				window: now.window,
				source: now.source,
				confirmations: now.confirmations,
			});
		}
		drafts.push({ type: "custom", customType: STATE_TYPE, data: core.snapshot(limits.key) });
		log(
			`overflow: "${errorMessage}" limit=${limit} requested=${requested} sent=${Math.round(sent)} window ${limits.window} -> ${state.learned?.window ?? limits.window} (confirmations ${state.learned?.confirmations ?? 0})`,
		);
		return state.learned?.window ?? limits.window;
	}
	core.learnFromOverflow = learnFromOverflow;

	// --------------------------------------------------------------- E7 / H4 output clamp
	pi.on("before_provider_request", (event, ctx) => {
		const original = event.payload;
		if (!original || typeof original !== "object") return undefined;
		const payload = original;
		const limits = resolveLimits(ctx);
		const input = st.lastSent ? st.lastSent.estimate * core.ratioFor(limits.key) : 0;
		// A request may ask for more than the reserve when the actual request leaves room (H8).
		let allowed = Math.max(256, Math.min(limits.maxOutput, Math.floor(limits.hardWindow - input - 512)));
		// G1: the retry after an output-caused combined error asks for what the provider said is left.
		const capOnce = st.outputCapOnce;
		if (capOnce !== undefined) allowed = Math.min(allowed, capOnce);
		const next = { ...(payload as Record<string, unknown>) };
		let changed = false;
		let sent: number | undefined;
		let asked = 0;
		const clamp = (holder: Record<string, unknown>, key: string) => {
			const value = holder[key];
			if (typeof value !== "number") return;
			asked = Math.max(asked, value);
			// Only ever lower: cache-warming requests send 1 through this hook on purpose.
			if (value > allowed) {
				holder[key] = allowed;
				changed = true;
			}
			sent ??= holder[key] as number;
		};
		for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxTokens", "maxOutputTokens"]) {
			clamp(next, key);
		}
		for (const nested of ["generationConfig", "inferenceConfig"]) {
			if (next[nested] && typeof next[nested] === "object") {
				next[nested] = { ...(next[nested] as Record<string, unknown>) };
				clamp(
					next[nested] as Record<string, unknown>,
					nested === "generationConfig" ? "maxOutputTokens" : "maxTokens",
				);
			}
		}
		// G1: the one-shot cap is spent by the request it bounds. A cache-warming replay asks for 1 token,
		// less than the cap, and leaves it for the retry.
		if (capOnce !== undefined && asked > capOnce) st.outputCapOnce = undefined;
		// A cache-warming replay (max_tokens 1) is not the request whose output limit the engine tracks.
		if (asked > 1 || sent === undefined) st.lastOutputLimit = { sent, lowered: changed };
		const thinking = next.thinking as { budget_tokens?: number } | undefined;
		if (changed && thinking && typeof thinking.budget_tokens === "number" && typeof next.max_tokens === "number") {
			next.thinking = {
				...thinking,
				budget_tokens: Math.min(thinking.budget_tokens, Math.max(1024, (next.max_tokens as number) - 1)),
			};
		}
		if (!changed) return undefined;
		stats.clampedOutput++;
		return next;
	});
}
