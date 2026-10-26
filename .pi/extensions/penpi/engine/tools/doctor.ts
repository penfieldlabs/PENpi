import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "../core.ts";
import { REPLAY_CHECK_PAIRS } from "../detector.ts";
import { kTokens, STATE_TYPE } from "../options.ts";
import { describeFaults } from "../recovery.ts";
import type { Limits, ModelState } from "../state.ts";

export function installDoctor(core: EngineCore): void {
	const { pi, opts, stats, log, pinOpts, st } = core;

	// ---------------------------------------------------------------- status line and doctor (H8)
	function currentSeq(): number {
		return st.index?.cut?.seq ?? 0;
	}

	function updateStatus(ctx: ExtensionContext, limits: Limits): void {
		stats.lastLimits = {
			key: limits.key,
			window: limits.window,
			reason: limits.reason,
			declaredWindow: limits.declaredWindow,
			budget: limits.budget,
			high: limits.high,
			low: limits.low,
			reserve: limits.reserve,
			maxOutput: limits.maxOutput,
		};
		const differs = limits.declaredWindow !== limits.window;
		const model = differs
			? ` (model ${limits.declaredWindow ? kTokens(limits.declaredWindow) : "?"}, ${limits.reason})`
			: "";
		const request =
			st.lastRequestTokens === undefined ? "" : ` · req ${kTokens(st.lastRequestTokens)}/${kTokens(limits.high)}`;
		const faultFlag = core.faults ? "FAULTS ON · " : "";
		const text = `${faultFlag}ctx ${kTokens(limits.window)}${model}${request} · ${currentSeq()} cuts · ratio ${core.ratioFor(limits.key).toFixed(2)}`;
		stats.statusTexts.push(text);
		ctx.ui.setStatus(STATE_TYPE, text);
	}
	core.updateStatus = updateStatus;

	/**
	 * The symptom of a provider that does not count replayed reasoning while the budget does: with
	 * thinking on, the ratio settles at the floor (the provider reports less than the estimate).
	 */
	function replayHint(key: string, state: ModelState): string {
		if (st.replayIgnored || state.samples < opts.silentSettledSamples) return "";
		let thinking = "off";
		try {
			thinking = pi.getThinkingLevel();
		} catch {}
		if (thinking === "off" || core.clampRatio(state.ratio) > opts.ratioFloor * 1.02) return "";
		return `; the ratio is at the ${opts.ratioFloor} floor with thinking on, the symptom of a provider that does not count the reasoning Pi replays: measure it, and if so set replayedReasoning { "${key}": "ignored" }`;
	}

	/** The replay check: what the provider does with replayed reasoning, measured this session. */
	function replayCheckLine(key: string): string {
		const { pairs, median, verdict, recommendation } = core.replayCheck(key);
		if (median === undefined) return "replay check: no request pairs with enough replayed reasoning yet";
		const observed =
			verdict === "counted"
				? "the provider counts it"
				: verdict === "ignored"
					? "the provider ignores it"
					: "no verdict: between 0.3 and 0.5, or the pairs split into some that count it and some that do not";
		const judged =
			pairs < REPLAY_CHECK_PAIRS
				? `${REPLAY_CHECK_PAIRS} pairs needed to judge`
				: recommendation !== undefined
					? verdict === undefined
						? `some pairs count it and the setting is "ignored": recommends "counted" (warned)`
						: "disagrees with the setting (warned)"
					: verdict === undefined
						? "no recommendation"
						: "agrees with the setting";
		return `replay check: ${pairs} request pairs, median share ${median.toFixed(2)} of the replayed reasoning reported (${observed}); ${judged}`;
	}

	function doctorReport(ctx: ExtensionContext): string {
		const limits = core.resolveLimits(ctx);
		const n = (value: number) => Math.round(value).toLocaleString("en-US");
		const model = ctx.model;
		const registered = model ? !!ctx.modelRegistry.find(model.provider, model.id) : false;
		const state = limits.state;
		const learned = [...st.models.entries()].flatMap(([key, m]) => {
			const l = m.learned;
			if (!l) return [];
			const truncated = l.truncatedTurns?.length
				? `; answers from truncated input: ${l.truncatedTurns.map((t) => `turn ${t.turn ?? "?"} (entry ${t.entryId ?? "?"})`).join(", ")}`
				: "";
			const expiry =
				l.source === "plateau"
					? `this session only, ${
							Number.isFinite(l.probeAfter)
								? l.window > l.base
									? `re-probing at ${n(l.window)}`
									: `re-probed after ${Math.max(0, l.probeAfter - l.cleanNear)} more clean requests (below ${Math.round(opts.silentReprobeBelow * 100)}% of the planning window; ${m.silentProbes}/${opts.silentReprobes} re-probes used)`
								: l.window >= opts.silentReprobeBelow * l.declared
									? `never re-probed (at or above ${Math.round(opts.silentReprobeBelow * 100)}% of the planning window; probing would truncate silently)`
									: `not re-probed again (${m.silentProbes}/${opts.silentReprobes} re-probes used this session)`
						}${truncated}; clear with /${opts.commandName} reset-limits`
					: l.confirmations >= opts.probeConfirmations
						? `permanent after ${l.confirmations} failed re-probes`
						: l.window > l.base
							? `probing at ${n(l.window)}: retired when a request above ${n(l.evidenceAbove ?? l.base)} succeeds, confirmed by a rejection near ${n(l.base)} (${l.confirmations}/${opts.probeConfirmations} confirmations)`
							: `re-probe toward ${n(l.declared)} after ${Math.max(0, l.probeAfter - l.cleanNear)} more clean requests near the limit (${l.cleanNear}/${l.probeAfter}; ${l.confirmations}/${opts.probeConfirmations} confirmations)`;
			return [`  ${key}: ${n(l.window)} (${l.source}; evidence base ${n(l.base)}; ${expiry})`];
		});
		let decisionsText = 0;
		let decisionsImages = 0;
		for (const decision of st.decisions.values()) {
			if (decision.chars !== undefined) decisionsText++;
			if (decision.dropImages?.length) decisionsImages++;
		}
		const compactionOff = !compactionEnabled();
		const lines = [
			"context-engine doctor",
			`model: ${limits.key}${registered ? "" : " (not in the model registry)"}`,
			`declared: window ${limits.declaredWindow ? n(limits.declaredWindow) : "none"}, max output ${limits.declaredMax ? n(limits.declaredMax) : "none"}${limits.plausibleMax || !limits.declaredMax ? "" : ` (implausible: above ${Math.round(opts.implausibleOutputFraction * 100)}% of the window)`}`,
			`effective window: ${n(limits.window)} (reason: ${limits.reason}; ceiling ${core.ceiling ? n(core.ceiling) : "off"}${core.perModel[limits.key]?.contextWindow ? `; override ${n(core.perModel[limits.key].contextWindow!)}` : ""})`,
			`max output: ${n(limits.maxOutput)} (${limits.maxOutputReason}); a request may ask up to min(max output, ${n(limits.hardWindow)} - input)`,
			`output reserve: ${n(limits.reserve)} = min(max output, ${Math.round(opts.outputReserveFraction * 100)}% of the window)`,
			`input budget: ${n(limits.budget)} = window - output reserve`,
			`band: cut above ${n(limits.high)}, cut down to ${n(limits.low)} (${Math.round(opts.highWater * 100)}% / ${Math.round(opts.lowWater * 100)}% of the budget)`,
			`calibration: ratio ${core.ratioFor(limits.key).toFixed(3)} over ${state.samples} samples for ${limits.key} (floor ${opts.ratioFloor}, ceiling ${opts.ratioCeiling})`,
			// Truncation by a server that reports no usage, or by less than about a quarter of each
			// append, cannot be told from an honest request.
			state.samples === 0 && (state.noUsage ?? 0) > 0
				? `silent-truncation detection unavailable: no usage reported (${state.noUsage} answers without input usage)`
				: `silent-truncation detection: on (judges requests that only grew; evidence is reported growth below ${Math.round(opts.silentShortfall * 100)}% of the append)`,
			`replayed reasoning: ${st.replayIgnored ? "ignored (left out of the budget)" : "counted"} for ${limits.key}${replayHint(limits.key, state)}`,
			replayCheckLine(limits.key),
			`learned windows:${learned.length ? `\n${learned.join("\n")}` : " none"}`,
			`learned output: ${state.output.ceiling ? `provider ceiling ${n(state.output.ceiling)} (from ${state.output.ceilingSource === "error" ? "an output-limit error" : "length stops"})` : "no provider ceiling"}, ${state.output.raised ? `raised to ${n(state.output.raised)}` : "not raised"}${state.output.contextLimit ? `, output room bounded by a stated context of ${n(state.output.contextLimit)}` : ""}`,
			`unit caps: one unit at most ${n(limits.maxUnit)} tokens (${Math.round(opts.maxUnitFraction * 100)}% of the budget); ${st.decisions.size} frozen decisions (${decisionsText} text, ${decisionsImages} with images replaced)`,
			`window: #${currentSeq()}${st.lastRequestTokens === undefined ? "" : `, last request ${n(st.lastRequestTokens)} tokens (${Math.round((100 * st.lastRequestTokens) / limits.high)}% of the cut threshold)`}`,
			`user-message pin: ${pinOpts ? `on (cap ${n(core.pinCap())} = min(${Math.round(pinOpts.capFraction * 100)}% of the window, ${n(pinOpts.capMaxTokens)}); sources ${pinOpts.sources.join(", ")}; unrecorded ${pinOpts.unrecordedSource}; last request carried ${n(stats.pinTokens.at(-1) ?? 0)} tokens, largest ${n(Math.max(0, ...stats.pinTokens))})` : "off"}`,
			`pre-cut notice: ${opts.notice ? "on" : "off"}`,
			`compaction.enabled is false: ${compactionOff ? "yes" : "NO (the engine refuses to run)"}`,
			`fault injection: ${core.faults ? `ON (${describeFaults(core.faults)}); ${stats.faults.length} injected so far` : core.faultsRefused ? `REFUSED (${core.faultsRefused} marks production)` : "off"}`,
		];
		return lines.join("\n");
	}

	/** G2: forget every learned window and output limit of this session (plateau ones included). */
	function resetLimits(ctx: ExtensionContext): string {
		const cleared: string[] = [];
		for (const [key, state] of st.models) {
			const clearedParts = [
				state.learned ? `window ${state.learned.window} (${state.learned.source})` : "",
				state.output.ceiling ? `output ceiling ${state.output.ceiling}` : "",
				state.output.raised ? `raised output ${state.output.raised}` : "",
				state.output.contextLimit ? `output room ${state.output.contextLimit}` : "",
			].filter(Boolean);
			state.learned = undefined;
			state.output = { stops: [] };
			state.warnedPlateau = false;
			state.history = [];
			state.recent = [];
			state.suspects = [];
			state.providerParked = undefined;
			if (clearedParts.length > 0) {
				cleared.push(`${key}: ${clearedParts.join(", ")}`);
				core.persistModel(key);
			}
		}
		stats.limitResets++;
		const text = cleared.length
			? `context-engine: learned limits cleared for this session: ${cleared.join("; ")}.`
			: "context-engine: no learned limits to clear.";
		log(`reset-limits: ${cleared.join("; ") || "nothing"}`);
		updateStatus(ctx, core.resolveLimits(ctx));
		return text;
	}

	const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const sub = args.trim();
		if (sub === "doctor" || sub === "") ctx.ui.notify(doctorReport(ctx), "info");
		else if (sub === "reset-limits") ctx.ui.notify(resetLimits(ctx), "info");
		else ctx.ui.notify(`usage: /${opts.commandName} doctor | reset-limits`, "warning");
	};
	core.command = command;
	// Inside PENpi the extension's own /penpi command routes `doctor` and `reset-limits` here.
	if (core.wiring.registerCommand !== false)
		pi.registerCommand(opts.commandName, {
			description:
				"context-engine: `doctor` prints the window, band, calibration and learned limits; `reset-limits` forgets learned limits",
			handler: command,
		});

	// --------------------------------------------------------------- P5
	// An unset compaction.enabled means the host's default: on in stock Pi, off in PENpi (wiring).
	const compactionEnabled = () => {
		const enabled = pi.getSettings().compaction?.enabled;
		return enabled === undefined ? core.wiring.compactionOffByDefault !== true : enabled !== false;
	};
	core.compactionEnabled = compactionEnabled;
	const refusal =
		"context-engine: refusing to run because compaction.enabled is not false (Pi's default is true). " +
		"With it on, Pi summarizes or drops context on its own paths before the engine is asked. " +
		'Add "compaction": { "enabled": false } to ~/.pi/agent/settings.json and restart.';
	core.refusal = refusal;

	pi.on("input", (event, ctx) => {
		// Remember where the input came from; the user message it becomes is matched at message_end.
		if (event.source === "interactive" || event.source === "rpc" || event.source === "extension") {
			// D7: an input given while idle becomes its user message before the next input arrives, unless an
			// extension handled it; an idle input still pending now was handled, so it is dropped (it would
			// otherwise pair with a later message). Queued inputs (steer, follow-up) wait for their message.
			const queued = event.streamingBehavior !== undefined;
			const kept = queued ? st.pendingInputs : st.pendingInputs.filter((p) => p.queued);
			st.pendingInputs = [...kept.slice(-31), { source: event.source, text: event.text ?? "", queued }];
		}
		if (opts.onCompactionEnabled !== "fail") return undefined;
		if (!st.refused && !compactionEnabled()) return undefined;
		st.refused = true;
		stats.refused = true;
		ctx.ui.notify(refusal, "error");
		return { action: "handled" };
	});
}
