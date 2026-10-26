import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { EngineCore } from "./core.ts";
import { STATE_TYPE, type TruncatedTurn } from "./options.ts";
import type { ModelState } from "./state.ts";

/** The replay check decides from this many request pairs on (spec: 20 or more). */
export const REPLAY_CHECK_PAIRS = 20;
/** A pair counts only when its replayed reasoning is at least this many tokens and this share of the text. */
const REPLAY_MIN_TOKENS = 64;
const REPLAY_MIN_SHARE = 0.5;

function replayMedian(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The replay check's verdict from its shares, or none. "counted" from a median of 0.5; "ignored" only below
 * 0.3, since the estimator's error is systematic per model and an over-counting estimator pulls a counting
 * provider toward "ignored", the direction that under-counts. The rule is asymmetric. "ignored" is withheld
 * while a tenth of the pairs, or 3 of them, are at 0.5 or more: those count the replay (a provider that keeps
 * reasoning only inside a tool loop, an over-counted 0.6), and "ignored" would under-count them. "counted",
 * the safe direction, is withheld only when a quarter of the pairs are below 0.3. In between, no verdict.
 */
export function replayVerdict(shares: number[]): "counted" | "ignored" | undefined {
	const low = shares.filter((share) => share < REPLAY_IGNORED_BELOW).length;
	const median = replayMedian(shares);
	if (median >= REPLAY_COUNTED_FROM) return low >= REPLAY_COUNTED_BLOCK * shares.length ? undefined : "counted";
	if (median < REPLAY_IGNORED_BELOW) return someCountReplay(shares) ? undefined : "ignored";
	return undefined;
}

/** The pairs that withhold "ignored": a tenth of them, or 3 (whichever is fewer), at 0.5 or more. */
function someCountReplay(shares: number[]): boolean {
	const high = shares.filter((share) => share >= REPLAY_COUNTED_FROM).length;
	return high >= Math.min(REPLAY_IGNORED_BLOCK_PAIRS, REPLAY_IGNORED_BLOCK * shares.length);
}

/**
 * The value the replay check recommends for a setting, or none: the verdict when it disagrees with the
 * setting. Without a verdict, "counted" when the setting is "ignored" and enough pairs count the replay
 * (the pairs that withhold "ignored"): those requests are under-counted, the risky direction. A setting of
 * "counted" without a verdict gets no recommendation.
 */
export function replayRecommendation(
	shares: number[],
	setting: "counted" | "ignored",
): "counted" | "ignored" | undefined {
	const verdict = replayVerdict(shares);
	if (verdict !== undefined) return verdict === setting ? undefined : verdict;
	return setting === "ignored" && someCountReplay(shares) ? "counted" : undefined;
}
const REPLAY_COUNTED_FROM = 0.5;
const REPLAY_IGNORED_BELOW = 0.3;
/** "counted" is withheld when this share of the pairs is below 0.3. */
const REPLAY_COUNTED_BLOCK = 0.25;
/** "ignored" is withheld when this share of the pairs, or this many, are at 0.5 or more (whichever is fewer). */
const REPLAY_IGNORED_BLOCK = 0.1;
const REPLAY_IGNORED_BLOCK_PAIRS = 3;

/** The silent-truncation warning's count of answers, in the singular for one. */
export function answersProduced(count: number): string {
	return count === 1 ? "1 answer was produced" : `${count} answers were produced`;
}

export function installDetector(core: EngineCore): void {
	const { opts, stats, log, st } = core;

	/**
	 * The replay check (warn-only). Between two consecutive requests with no cut, reported usage grows by the
	 * appended text, plus the replayed reasoning if the provider counts it. Each pair whose replayed reasoning
	 * is large enough to tell gives the share of it that the growth accounted for (about 1: counted, about
	 * 0: ignored). From REPLAY_CHECK_PAIRS pairs on, a median that disagrees with replayedReasoning is warned
	 * about once per session per model, naming the setting and the value to try.
	 */
	function checkReplay(
		key: string,
		sent: NonNullable<typeof st.lastSent>,
		delta: number,
		ctx: ExtensionContext,
	): void {
		// Uncalibrated estimates: with the setting wrong, the calibration ratio absorbs the very share measured
		// (it climbs when the provider counts what the budget leaves out). The estimator stays within about
		// 0.85-1.12 of real tokenizers; a pair counts only when the replay is at least half the text, so that
		// error moves a share by at most about 0.3 (replayVerdict says how the shares decide).
		const replay = sent.appendedReplay;
		const text = sent.appendedText + sent.appendedAsText - sent.noticeDrop;
		if (replay < REPLAY_MIN_TOKENS || replay < REPLAY_MIN_SHARE * text || delta <= 0) return;
		const shares = [...(st.replayShares.get(key) ?? []).slice(-63), (delta - text) / replay];
		st.replayShares.set(key, shares);
		stats.replayChecks[key] = { pairs: shares.length, median: replayMedian(shares) };
		if (shares.length < REPLAY_CHECK_PAIRS || st.replayWarned.has(key)) return;
		const median = replayMedian(shares);
		const setting = opts.replayedReasoning?.[key] === "ignored" ? "ignored" : "counted";
		const observed = replayRecommendation(shares, setting);
		if (observed === undefined) return;
		st.replayWarned.add(key);
		stats.replayWarnings.push({ key, setting, observed, median, pairs: shares.length });
		const counting = shares.filter((share) => share >= REPLAY_COUNTED_FROM).length;
		const what =
			replayVerdict(shares) === undefined
				? `counts the reasoning Pi replays in ${counting} of ${shares.length} request pairs with no cut (a share of 0.5 or more of the replayed reasoning reported; median share ${median.toFixed(2)})`
				: `${observed === "counted" ? "counts" : "ignores"} the reasoning Pi replays ` +
					`(reported growth against the appended text plus the replayed reasoning: median share ${median.toFixed(2)} over ${shares.length} request pairs with no cut)`;
		const warning =
			`context-engine: ${key} ${what}, ` +
			`but replayedReasoning is "${setting}", so the budget ${setting === "ignored" ? (replayVerdict(shares) === undefined ? "under-counts those requests" : "under-counts every request") : "over-counts and the window is under-used"}. ` +
			`Try replayedReasoning { "${key}": "${observed}" }${observed === "counted" ? " (the default: remove the entry)" : ""}.`;
		log(`replay check: ${warning.replace(/^context-engine: /, "")}`);
		ctx.ui.notify(warning, "warning");
	}
	core.replayCheck = (key) => {
		const shares = st.replayShares.get(key) ?? [];
		return {
			pairs: shares.length,
			median: shares.length ? replayMedian(shares) : undefined,
			verdict: shares.length ? replayVerdict(shares) : undefined,
			recommendation:
				shares.length >= REPLAY_CHECK_PAIRS
					? replayRecommendation(shares, opts.replayedReasoning?.[key] === "ignored" ? "ignored" : "counted")
					: undefined,
		};
	};

	function calibrate(assistant: AssistantMessage, ctx: ExtensionContext): void {
		st.overflowRetries = 0;
		st.outputRetries = 0;
		st.lastOutputProgress = true;
		const usage = assistant.usage;
		const reported = usage.input + usage.cacheRead + usage.cacheWrite;
		const sent = st.lastSent;
		st.lastSent = undefined;
		if (sent && reported <= 0) {
			const state = core.modelState(sent.key);
			state.noUsage = (state.noUsage ?? 0) + 1;
		}
		// D24: the upstream provider that served this response, if its stream named one.
		const servedBy = st.streamProvider;
		st.streamProvider = undefined;
		if (!sent || sent.estimate <= 0 || reported <= 0) return;
		const key = sent.key;
		const state = core.modelState(key);
		const switched = servedBy !== undefined && state.servedBy !== undefined && servedBy !== state.servedBy;
		const servedBefore = state.servedBy;
		if (servedBy !== undefined) state.servedBy = servedBy;
		// D24: at a switch, the previous provider's running maximum and evidence are set aside and the new one's
		// restored (N1, N2: evidence and a learned window come from one provider). The new provider's last sample
		// in the same append chain, if any, is the reference this sample is judged against (S1).
		let reference: { seq: number; reported: number; chain: number; cum: number } | undefined;
		if (switched && servedBefore !== undefined && servedBy !== undefined) {
			if (!state.providerParked) state.providerParked = new Map();
			const parked = state.providerParked;
			parked.set(servedBefore, {
				maxReported: state.maxReported,
				maxExpected: state.maxExpected,
				suspects: state.suspects,
			});
			const back = parked.get(servedBy);
			parked.delete(servedBy);
			state.maxReported = back?.maxReported ?? 0;
			state.maxExpected = back?.maxExpected;
			state.suspects = back?.suspects ?? [];
			const last = state.providerLast?.get(servedBy);
			reference = last && last.chain === sent.chain ? last : undefined;
			log(
				reference
					? `serving provider changed (${servedBefore} -> ${servedBy}): judged against ${servedBy}'s sample ${sent.seq - reference.seq} request(s) back`
					: `serving provider changed (${servedBefore} -> ${servedBy}): no sample from ${servedBy} since the last cut; the usage sample is not judged for truncation`,
			);
		}
		const sample = reported / sent.estimate;
		stats.calibrationSamples.push(sample);
		// Silent truncation. A provider that drops part of an oversized request reports less than it
		// was sent. Between two consecutive requests whose message list only grew, reported usage must
		// grow by about what was appended (text only: image costs differ too much between providers).
		// A sample that does not is quarantined: it is evidence, and it never moves the ratio or the
		// running maximum. A sample reporting exactly the running maximum again while it was expected
		// above it is evidence too (servers that fill their context report exactly the limit).
		const ratioBefore = core.clampRatio(state.ratio);
		const expected = sent.estimate * ratioBefore;
		const prev = state.lastSample;
		let suspect: string | undefined;
		let strong = false;
		const max = state.maxReported;
		// The exact-repeat rule below compares with the largest usage ever reported: only with settled
		// calibration (not during warm-up or after a model switch) and only for a different request than
		// the one that set it (identical windows report identical counts).
		const levelRepeat =
			max > 0 &&
			state.samples >= opts.silentSettledSamples &&
			Math.abs(expected - (state.maxExpected ?? 0)) >= 0.005 * expected;
		// A sample whose growth falls short but not far enough to be evidence never clears evidence.
		let marginal = false;
		// Only judged samples (the growth rule or the exact-repeat rule compared them) can be suspects;
		// unjudged ones (small appends, the sample after a length stop, warm-up after a model switch, no
		// append-only predecessor) are skipped and do not reset the count.
		// A request right after an answer cut at the output limit is never evidence on its own: what the
		// provider counts of a cut answer is provider-specific. It cannot clear evidence either.
		if (sent.afterLengthStop) {
			marginal = true;
			log("length stop: the next usage sample is not judged for truncation");
		} else if (switched && !reference) {
			// D24: a router (OpenRouter) moved the model to another upstream provider, which counts the same request
			// differently, and that provider served nothing since the last cut: nothing to judge this sample against.
			marginal = true;
		} else if (reference || (prev && prev.seq === sent.seq - 1 && sent.appendOnly)) {
			// The previous sample, or at a switch the new provider's own last sample in this append chain (D24):
			// usage must have grown by about the text appended since.
			const base = reference ?? (prev as { seq: number; reported: number });
			const grow = (reference ? sent.cum - reference.cum : sent.appendedText - sent.noticeDrop) * ratioBefore;
			const delta = reported - base.reported;
			const shown = `${Math.round(grow)} tokens appended, reported usage ${delta >= 0 ? "+" : ""}${delta}`;
			// An honest provider cannot report the same or less after text was appended, however little.
			if (delta <= 0 && grow >= opts.silentZeroGrowthFloor) {
				suspect = shown;
				strong = true;
			}
			// Otherwise an absolute floor: an honest provider counts the appended part exactly; only its
			// estimate varies, so small appends say little.
			else if (grow >= opts.silentMinGrowth) {
				if (delta < opts.silentShortfall * grow && expected >= 0.8 * max) {
					suspect = shown;
					// Most of a large append unaccounted for: no tokenizer overcounts text by that much
					// (the estimator's classes stay within 0.85-1.12 of o200k and GLM; a chars/4 count
					// within 3x).
					strong = grow >= opts.silentStrongGrowth && delta < opts.silentStrongShortfall * grow;
				} else if (delta < opts.silentMarginal * grow) marginal = true;
			}
		}
		if (
			!suspect &&
			!sent.afterLengthStop &&
			(!switched || reference !== undefined) &&
			levelRepeat &&
			reported === max &&
			expected > reported &&
			expected <= 1.6 * reported
		) {
			suspect = `reported exactly the previous maximum ${reported} again, expected about ${Math.round(expected)}`;
		}
		if (!suspect && !sent.afterLengthStop && !switched && prev && prev.seq === sent.seq - 1 && sent.appendOnly)
			checkReplay(key, sent, reported - prev.reported, ctx);
		state.lastSample = { seq: sent.seq, reported };
		if (servedBy !== undefined) {
			if (!state.providerLast) state.providerLast = new Map();
			state.providerLast.set(servedBy, {
				seq: sent.seq,
				reported,
				chain: sent.chain,
				cum: sent.cum,
			});
		}
		// D14: as long as the evidence span, so an answer truncated long before detection can still be named.
		state.recent = [
			...state.recent.slice(-(opts.silentEvidenceSpan - 1)),
			{ at: assistant.timestamp, expected, reported, ratio: state.ratio, suspect, provider: state.servedBy },
		];
		if (suspect) {
			state.suspects = [
				...state.suspects.filter((e) => state.samples - e.sample < opts.silentEvidenceSpan),
				{ reported, at: assistant.timestamp, sample: state.samples, why: suspect },
			];
			log(
				`silent truncation evidence ${state.suspects.length}/${opts.silentSuspects}${strong ? " (strong)" : ""}: ${suspect}; sample quarantined`,
			);
			// One strong sample acts at once; otherwise act on the second suspect among judged samples. Making
			// strong samples wait for a second would let truncating servers that drop whole messages answer
			// several times from truncated input before detection. Only a clean sample above the running
			// maximum clears the evidence (below); a clean sample below it does not.
			if (strong || state.suspects.length >= opts.silentSuspects) detectSilentTruncation(key, state, ctx);
			return;
		}
		// A clean sample above everything reported so far clears the evidence (the provider processed more
		// than the suspected limit). A truncated request may report only what the server kept, so a value
		// above that remainder proves nothing.
		if (
			state.suspects.length > 0 &&
			!marginal &&
			reported > Math.max(state.maxReported, ...state.suspects.map((e) => e.reported)) * (1 + opts.plateauFlatness)
		) {
			log(`silent truncation evidence cleared: ${reported} reported`);
			state.suspects = [];
		}
		if (reported > state.maxReported) {
			state.maxReported = reported;
			state.maxExpected = expected;
		}
		const alpha = state.samples < 3 ? 0.5 : 0.2;
		const previous = state.ratio;
		state.ratio = core.clampRatio(state.samples === 0 ? sample : state.ratio * (1 - alpha) + sample * alpha);
		state.samples++;
		let dirty = Math.abs(state.ratio - previous) / previous > 0.03 || state.samples % 50 === 0;
		// H3: count clean requests near a learned limit, then re-probe toward the declared window.
		// H8: only evidence retires a learned limit: a successful request above it. Stepping up to the
		// declared window does not, so a re-probe that fails near the old limit still counts as a
		// confirmation (with the 200k ceiling a 100k limit re-probes at 150k, whose band barely passes 100k).
		const learned = state.learned;
		// A plateau window is re-probed only when detection scheduled it (probeAfter finite).
		const probeable = learned && (learned.source !== "plateau" || Number.isFinite(learned.probeAfter));
		if (learned && probeable && learned.confirmations < opts.probeConfirmations) {
			const evidence = learned.evidenceAbove ?? learned.base;
			if (learned.window > learned.base && reported > evidence) {
				state.learned = undefined;
				stats.probes.push({ key, from: learned.window, to: learned.declared });
				log(`probe: ${reported} > ${evidence} succeeded at ${learned.window} (learned window retired)`);
				dirty = true;
			} else if (learned.window < learned.declared) {
				// D12: for a silent-learned window, "near" is half the engine's lowest possible high-water mark.
				// The engine does not send more than its high-water mark (0.75 x (window - reserve), as little as
				// 0.6 x window), so half the window was unreachable whenever appends exceeded about a tenth of it and
				// the re-probe that retires a false detection never started. Overflow-learned windows keep H3's rule.
				const near = learned.source === "plateau" ? 0.5 * opts.highWater * (1 - opts.outputReserveFraction) : 0.5;
				if (reported >= near * learned.window) learned.cleanNear++;
				if (learned.cleanNear >= learned.probeAfter) {
					const from = learned.window;
					const next = from + Math.max(0.5 * (learned.declared - from), 0.25 * from);
					learned.window = next >= 0.9 * learned.declared ? learned.declared : Math.floor(next);
					learned.cleanNear = 0;
					stats.probes.push({ key, from, to: learned.window });
					if (learned.source === "plateau") {
						state.silentProbes++;
						log(
							`probe: silent-learned window ${from} -> ${learned.window} (re-probe ${state.silentProbes}/${opts.silentReprobes} this session; a truncated probe answer is named)`,
						);
					} else log(`probe: ${from} -> ${learned.window}`);
					dirty = true;
				}
			}
		}
		if (dirty) core.persistModel(key);
	}
	core.calibrate = calibrate;

	// D24: OpenRouter's stream chunks name the upstream provider serving the request (top-level `provider`).
	core.pi.on("provider_stream_event", (event) => {
		const served = (event.data as { provider?: unknown } | null | undefined)?.provider;
		if (typeof served === "string" && served.length > 0) st.streamProvider = served;
	});

	/**
	 * Silent truncation found. The largest usage the provider ever reported is the window it
	 * really processes: learn it for this session (never re-probed: probing would truncate again),
	 * restore the ratio from before the affected samples, and name them (G2).
	 */
	function detectSilentTruncation(key: string, state: ModelState, ctx: ExtensionContext): void {
		const limits = core.resolveLimits(ctx);
		const max = Math.max(state.maxReported, ...state.suspects.map((e) => e.reported));
		const window = Math.min(limits.window, Math.floor(max));
		// Affected: the quarantined samples; samples that reported exactly what a quarantined one did (a
		// server that fills its context reports the limit every time); samples at the maximum that fell
		// clearly short of their expectation; and (D14) every sample expected above the learned window by
		// more than plateauFlatness. Once the window is known, a request that size cannot have been processed
		// whole, even when its usage grew by about its append (a server that dropped an old message smaller
		// than the append).
		const suspectCounts = new Set(state.suspects.map((e) => e.reported));
		// D24: only the samples of the provider being judged (all of them when responses name none).
		const affected = state.recent.filter(
			(s) =>
				s.provider === state.servedBy &&
				(s.suspect !== undefined ||
					suspectCounts.has(s.reported) ||
					(s.reported >= max * (1 - opts.plateauFlatness) &&
						s.expected > s.reported * (1 + opts.plateauFlatness)) ||
					s.expected > window * (1 + opts.plateauFlatness)),
		);
		if (affected.length > 0) state.ratio = affected[0].ratio;
		// Was a re-probe of a silent-learned window running? Then the truncated answers include the probe's.
		const probing = state.learned?.source === "plateau" && state.learned.window > state.learned.base;
		// Re-probe only an implausibly small window (below silentReprobeBelow of the planning window), and
		// at most silentReprobes times per session: against a real silent truncator a probe costs a truncated
		// answer, while a false detection can land at about a tenth of a 200k window.
		const reprobe =
			window < opts.silentReprobeBelow * limits.metadataWindow && state.silentProbes < opts.silentReprobes;
		state.learned = {
			window,
			base: window,
			declared: limits.metadataWindow,
			source: "plateau",
			confirmations: reprobe ? 0 : opts.probeConfirmations,
			cleanNear: 0,
			probeAfter: reprobe ? opts.probeAfterUnparsed : Number.POSITIVE_INFINITY,
			evidenceAbove: window,
			scope: "session",
		};
		stats.plateaus.push({ key, window });
		stats.learnedWindows.push({ key, window, source: "plateau", confirmations: 0 });
		core.persistModel(key);
		log(
			`silent truncation: ${state.suspects.map((e) => e.why).join("; ")}; largest usage ever reported ${max}; window -> ${window} (this session only)${probing ? "; the re-probe was truncated" : ""}; ${reprobe ? `re-probe after ${opts.probeAfterUnparsed} clean requests (${state.silentProbes}/${opts.silentReprobes} used)` : "not re-probed"}`,
		);
		st.pendingPlateau = { key, window, max, samples: affected, probing };
		state.recent = [];
		state.suspects = [];
		state.history = [];
	}

	/** G2: name the answers produced from truncated input, in the log, a warning and a session entry. */
	function reportPlateau(ctx: ExtensionContext, drafts: SessionBoundaryDraft[]): void {
		const pending = st.pendingPlateau;
		st.pendingPlateau = undefined;
		if (!pending) return;
		const assistants = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "message" && e.message.role === "assistant");
		const turns: TruncatedTurn[] = pending.samples.map((s) => {
			const assistantIndex = assistants.findIndex(
				(e) => e.type === "message" && (e.message as AssistantMessage).timestamp === s.at,
			);
			return {
				entryId: assistantIndex >= 0 ? assistants[assistantIndex].id : undefined,
				turn: assistantIndex >= 0 ? assistantIndex + 1 : undefined,
				at: new Date(s.at).toISOString(),
				expected: Math.round(s.expected),
				reported: s.reported,
				// During a re-probe, the answers to requests above the learned window are the probe's.
				...(pending.probing && s.expected > pending.window ? { probe: true } : {}),
			};
		});
		const state = core.modelState(pending.key);
		if (state.learned?.source === "plateau") state.learned.truncatedTurns = turns;
		stats.plateauReports.push({ key: pending.key, window: pending.window, turns });
		for (const t of turns) {
			log(
				`plateau: truncated ${t.probe ? "probe answer" : "answer"} entry=${t.entryId ?? "?"} turn=${t.turn ?? "?"} at=${t.at} expected~${t.expected} processed=${t.reported}`,
			);
		}
		drafts.push({
			type: "custom",
			customType: STATE_TYPE,
			data: { kind: "plateau", key: pending.key, window: pending.window, turns },
		});
		drafts.push({ type: "custom", customType: STATE_TYPE, data: core.snapshot(pending.key) });
		state.warnedPlateau = true;
		const named = turns
			.map(
				(t) => `turn ${t.turn ?? "?"} (entry ${t.entryId ?? "?"}, ${t.at}${t.probe ? ", a re-probe answer" : ""})`,
			)
			.join("; ");
		ctx.ui.notify(
			`context-engine: ${pending.key} silently truncated its input at about ${Math.floor(pending.max)} tokens (reported usage fell short of what the requests carried). ` +
				`${answersProduced(turns.length)} without part of their input (the provider may have dropped the start of the request: system prompt, window header, pinned task) and may be unreliable: ${named}. ` +
				`The window is now ${pending.window} tokens for this session only; /${opts.commandName} reset-limits clears it.`,
			"warning",
		);
	}
	core.reportPlateau = reportPlateau;
}
