/**
 * Metrics and pass criteria of one run.
 *
 * Request size = real tokens of the request as the engine sent it (before any silent truncation),
 * measured against the input budget the engine planned that request with (stats.sent[i].budget: window
 * minus output reserve; it shrinks when the engine learns a smaller window).
 *
 * Criteria (PASS/FAIL per run; null = not applicable; "vacuous" = passed because nothing happened):
 *   C1 rejections           rejections at call index >= 5 (calls 0-4 may calibrate) <= allowance. The
 *                           allowance is 0, except for an engine that re-probes learned limits (it reports
 *                           stats.probes): (1 + probeConfirmations) per limit it learned from an overflow.
 *   C2 largest              max(request / budget) <= 1.02
 *   C3 mean after 1st cut   mean(request / budget) over accepted requests after the first cut >= 0.45, the
 *                           low-water mark the band guarantees after a cut; the value itself is reported as a trend
 *                           (the whole session if the engine never cut)
 *   C4 breaks==cuts         every prefix break coincides with a cut and #breaks == #cuts; a trailing
 *                           message carrying the engine's notice marker is ignored (request-only)
 *   C5 truncated            silent modes: at most 5 truncated requests in the session
 *   C6 detection lag        silent modes: at most 3 truncated requests before the engine's first reported
 *                           detection (stats.plateaus); all of them if it never reports one
 *   C7 false detections     no detection reported without a truncated request since the previous one
 *                           (in reject mode: no detection at all); n/a for engines that do not report
 *   C8 named               silent modes: every truncated request the engine could see is named as produced
 *                           from truncated input (stats.plateauReports). It could see a truncation that removed
 *                           more than plateauFlatness plus the engine's estimate error at that call
 *                           (|estimate x ratio - real| / real), the band fixed in ADR 0032 before any outcome was
 *                           looked at, with the error capped at 5% of the request (a worse estimator does not
 *                           widen its own exemption). Truncations inside the band and answers named without
 *                           truncation are reported, not failed; n/a for engines that do not name answers. Across
 *                           a results directory (summarize.mjs): band-exempt truncations (inside the band and
 *                           unnamed) are reported beside C3 and fail the matrix above 10% of truncated requests
 */
import type { EngineStatsLike, EngineUnderTest } from "./engine-under-test.ts";
import type { SessionPlan } from "./mixes.ts";
import type { SimCall } from "./provider-sim.ts";
import { isSilent, type RunConfig } from "./runner.ts";

export const THRESHOLDS = {
	rejectionGraceCalls: 5,
	maxShare: 1.02,
	/** C3 floor: the band's low-water mark (decided after round 5; was 0.50). The value is reported as a trend. */
	meanShare: 0.45,
	maxTruncated: 5,
	maxDetectionLag: 3,
	/** C8: the engine's plateauFlatness default; override with engineOptions.plateauFlatness. */
	plateauFlatness: 0.02,
	/** C8: the estimate error the band allows is capped at this share of the request. */
	bandErrorCap: 0.05,
	/** The engine's default; override with engineOptions.probeConfirmations or E2_PROBE_CONFIRMATIONS. */
	probeConfirmations: 2,
	traceEvery: 25,
};

export interface Criterion {
	id: string;
	pass: boolean | null;
	value: string;
	threshold: string;
	note?: string;
}

export interface RunMetrics {
	id: string;
	config: RunConfig;
	engine: { label: string; sha256: string; source: string; loaded: string; via: string };
	tokenizer: string;
	corpusFingerprint: string;
	session: {
		plannedTurns: number;
		answeredTurns: number;
		abandonedTurns: number;
		tasks: number;
		classCounts: Record<string, number>;
		toolResultChars: number;
		promptErrors: string[];
	};
	calls: number;
	alignment: { sentRecords: number; calls: number; ok: boolean };
	limits: {
		hardLimit: number;
		limitRule: string;
		firstBudget?: number;
		lastBudget?: number;
		minBudget?: number;
		lastWindow?: number;
	};
	rejections: {
		count: number;
		late: number;
		at: number[];
		errorStyle: string;
		firstErrorText?: string;
		/** C1: late rejections allowed (0 unless the engine re-probes learned limits). */
		allowance: number;
		reprobingEngine: boolean;
		learnedLimits: number;
	};
	largest: { tokens: number; at: number; budget: number; shareOfBudget: number; shareOfHardLimit: number };
	share: {
		mean: number;
		min: number;
		/** C3: mean over accepted requests after the first cut (null: no cut). */
		meanAfterFirstCut: number | null;
		minAfterFirstCut: number | null;
		p50: number;
		p95: number;
	};
	ratioTrace: Record<
		string,
		Array<{
			call: number;
			engineRatio: number;
			trueRatio: number;
			reportedRatio: number;
			estimate: number;
			tokens: number;
			budget: number;
		}>
	>;
	cuts: { count: number; at: number[] };
	prefix: {
		breaks: number;
		at: number[];
		breaksWithoutCut: number[];
		cutsWithoutBreak: number[];
		noticeTails: number;
	};
	silent: {
		truncated: number;
		at: number[];
		truncatedTokens: number;
		/** Calls at which the engine reported a silent-truncation detection (stats.plateaus grew). */
		engineDetectedAt: number[];
		/** Truncated requests before the engine's first reported detection (null: it never reported one). */
		lagToDetection: number | null;
		lastTruncated: number | null;
	} | null;
	/** Detections reported without a truncated request since the previous one (null: engine does not report). */
	falseDetections: { count: number; at: number[] } | null;
	/**
	 * C8: call indices of the answers the engine named; truncated requests outside the band it did not name
	 * (fail), inside the band it did not name (reported), and answers named without truncation (reported).
	 */
	named: {
		at: number[];
		truncated: number;
		visible: number;
		unnamed: number[];
		unnamedInBand: number[];
		/** Tokens the band-exempt truncations (inside the band, unnamed) lost. */
		inBandTokens: number;
		wronglyNamed: number[];
		unmatched: number;
	} | null;
	engineStats: Record<string, unknown>;
	images: { requestsWithImages: number; maxImageTokens: number };
	criteria: Criterion[];
	verdict: "PASS" | "FAIL";
	runtimeMs: number;
	tokenizerWork: { calls: number; chars: number; ms: number };
	notices: string[];
	series: {
		/** Real tokens of each request as sent. */
		tokens: number[];
		/** usage.input the provider reported for it (lower than tokens when truncated; null when rejected). */
		reported: Array<number | null>;
		budget: number[];
		estimate: number[];
		ratio: number[];
		flags: string[];
	};
}

export interface EvaluateInput {
	config: RunConfig;
	engine: EngineUnderTest;
	stats: EngineStatsLike;
	calls: SimCall[];
	plan: SessionPlan;
	answered: number;
	abandoned: number;
	promptErrors: string[];
	notices: string[];
	tokenizerSource: string;
	tokenizerStats: { calls: number; chars: number; ms: number };
	corpusFingerprint: string;
	runtimeMs: number;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

function quantile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** A break is a request whose message list does not extend the previous request's (minus a notice tail). */
export function prefixBreaks(calls: SimCall[]): { at: number[]; noticeTails: number } {
	const at: number[] = [];
	let noticeTails = 0;
	for (let i = 1; i < calls.length; i++) {
		let previous = calls[i - 1].keys;
		if (calls[i - 1].noticeTail) {
			previous = previous.slice(0, -1);
			noticeTails++;
		}
		const current = calls[i].keys;
		let k = 0;
		while (k < previous.length && k < current.length && previous[k] === current[k]) k++;
		if (k < previous.length) at.push(i);
	}
	return { at, noticeTails };
}

export function evaluate(input: EvaluateInput): RunMetrics {
	const { config, engine, stats, calls } = input;
	const n = calls.length;
	const budgetAt = (c: SimCall) => c.observed?.budget ?? Number.NaN;
	const shares = calls.map((c) => c.input / budgetAt(c));
	const accepted = calls.filter((c) => !c.rejected);
	const acceptedShares = accepted.map((c) => c.input / budgetAt(c));

	// Cuts per call: the engine's cut counter grew while it prepared this request.
	const cutAt: number[] = [];
	for (let i = 0; i < n; i++) {
		const now = calls[i].observed?.cuts ?? 0;
		const before = i === 0 ? 0 : (calls[i - 1].observed?.cuts ?? 0);
		if (now > before) cutAt.push(i);
	}
	const cutsTotal = stats.cuts.length;
	const { at: breakAt, noticeTails } = prefixBreaks(calls);
	const cutSet = new Set(cutAt);
	const breakSet = new Set(breakAt);
	const breaksWithoutCut = breakAt.filter((i) => !cutSet.has(i));
	const cutsWithoutBreak = cutAt.filter((i) => !breakSet.has(i));

	const rejectedAt = calls.filter((c) => c.rejected).map((c) => c.index);
	const late = rejectedAt.filter((i) => i >= THRESHOLDS.rejectionGraceCalls);

	let largestIndex = 0;
	for (let i = 1; i < n; i++) if (shares[i] > shares[largestIndex]) largestIndex = i;
	const largestCall = calls[largestIndex];

	const firstCut = cutAt[0];
	const afterCut =
		firstCut === undefined ? [] : accepted.filter((c) => c.index > firstCut).map((c) => c.input / budgetAt(c));

	const trace: RunMetrics["ratioTrace"][string] = [];
	for (let i = 0; i < n; i += THRESHOLDS.traceEvery) {
		const c = calls[i];
		const estimate = c.observed?.estimate ?? Number.NaN;
		trace.push({
			call: i,
			engineRatio: round(c.observed?.ratio ?? Number.NaN),
			trueRatio: round(c.input / estimate),
			reportedRatio: round(c.processed / estimate),
			estimate: Math.round(estimate),
			tokens: c.input,
			budget: Math.round(budgetAt(c)),
		});
	}

	const silent = isSilent(config.mode);
	const truncated = calls.filter((c) => c.truncated);
	const reportsDetections = Array.isArray(stats.plateaus);
	const detections: number[] = [];
	for (let i = 0; i < n; i++) {
		const now = calls[i].observed?.plateaus ?? 0;
		const before = i === 0 ? 0 : (calls[i - 1].observed?.plateaus ?? 0);
		if (now > before) detections.push(i);
	}
	// A detection at the response to the last call shows only in the final stats.
	if ((stats.plateaus?.length ?? 0) > (calls.at(-1)?.observed?.plateaus ?? 0)) detections.push(n);
	const falseAt = detections.filter((d, k) => {
		const since = k === 0 ? 0 : detections[k - 1];
		return !truncated.some((c) => c.index >= since && c.index < d);
	});
	// C8: map each named answer to its call by the answer's timestamp.
	const reportsNames = Array.isArray(stats.plateauReports);
	const callAt = new Map<number, number>();
	for (const c of calls) if (c.answerAt !== undefined) callAt.set(c.answerAt, c.index);
	const namedTimes = (stats.plateauReports ?? []).flatMap((r) => r.turns.map((t) => Date.parse(t.at)));
	const namedAt = [...new Set(namedTimes.flatMap((t) => (callAt.has(t) ? [callAt.get(t) as number] : [])))].sort(
		(a, b) => a - b,
	);
	const unmatchedNames = namedTimes.filter((t) => !callAt.has(t)).length;
	const truncatedSet = new Set(truncated.map((c) => c.index));
	const namedSet = new Set(namedAt);
	const flatness = Number(config.engineOptions.plateauFlatness ?? THRESHOLDS.plateauFlatness);
	const visible = (c: SimCall) => {
		const expected = (c.observed?.estimate ?? Number.NaN) * (c.observed?.ratio ?? Number.NaN);
		const error = Math.abs(expected - c.input) / c.input;
		// Without an estimate the band is unknown: count the truncation as visible.
		return (
			!Number.isFinite(error) || c.truncatedTokens / c.input > flatness + Math.min(error, THRESHOLDS.bandErrorCap)
		);
	};
	const visibleTruncated = truncated.filter(visible);
	const unnamed = visibleTruncated.filter((c) => !namedSet.has(c.index)).map((c) => c.index);
	const inBand = truncated.filter((c) => !visible(c) && !namedSet.has(c.index));
	const unnamedInBand = inBand.map((c) => c.index);
	const inBandTokens = inBand.reduce((sum, c) => sum + c.truncatedTokens, 0);
	const wronglyNamed = namedAt.filter((i) => !truncatedSet.has(i));
	const lag = detections.length ? truncated.filter((c) => c.index < detections[0]).length : truncated.length;

	// C1: an engine that re-probes learned limits may be rejected once per limit plus once per probe confirmation.
	const reprobing = Array.isArray(stats.probes);
	const learnedLimits = (stats.learnedWindows ?? []).filter(
		(w) => w.source !== "plateau" && (w.confirmations ?? 0) === 0,
	).length;
	const probeConfirmations = Number(
		config.engineOptions.probeConfirmations ?? process.env.E2_PROBE_CONFIRMATIONS ?? THRESHOLDS.probeConfirmations,
	);
	const allowance = reprobing ? learnedLimits * (1 + probeConfirmations) : 0;

	const meanShare = acceptedShares.reduce((s, x) => s + x, 0) / Math.max(1, acceptedShares.length);
	const meanAfterCut = afterCut.length ? afterCut.reduce((s, x) => s + x, 0) / afterCut.length : null;
	const c3Share = meanAfterCut ?? meanShare;
	const vacuous = silent && truncated.length === 0 ? "vacuous: nothing was truncated" : undefined;
	const criteria: Criterion[] = [
		{
			id: "C1 rejections",
			pass: late.length <= allowance,
			value: `${late.length} after call ${THRESHOLDS.rejectionGraceCalls - 1} (${rejectedAt.length} total${late.length ? `, at ${late.slice(0, 8).join(",")}` : ""})`,
			threshold: reprobing
				? `<= ${allowance} = ${learnedLimits} learned limit(s) x (1 + ${probeConfirmations} probe confirmations)`
				: "0 (engine does not re-probe)",
			note: silent ? "silent provider never rejects" : undefined,
		},
		{
			id: "C2 largest",
			pass: shares[largestIndex] <= THRESHOLDS.maxShare,
			value: `${round(shares[largestIndex])} (${largestCall?.input} tok at call ${largestIndex}, budget ${Math.round(budgetAt(largestCall))})`,
			threshold: `<= ${THRESHOLDS.maxShare} x budget`,
		},
		{
			id: "C3 mean-after-cut",
			pass: c3Share >= THRESHOLDS.meanShare,
			value: `${round(c3Share)} (whole session ${round(meanShare)})`,
			threshold: `>= ${THRESHOLDS.meanShare} x budget`,
			note: meanAfterCut === null ? "no cut in the session: judged on the whole session" : undefined,
		},
		{
			id: "C4 breaks==cuts",
			pass: breaksWithoutCut.length === 0 && breakAt.length === cutAt.length,
			value: `${breakAt.length} breaks, ${cutAt.length} cut requests (${cutsTotal} cuts)${breaksWithoutCut.length ? `; breaks without cut at ${breaksWithoutCut.slice(0, 8).join(",")}` : ""}${cutsWithoutBreak.length ? `; cuts without break at ${cutsWithoutBreak.slice(0, 8).join(",")}` : ""}`,
			threshold: "equal, aligned",
		},
		{
			id: "C5 truncated",
			pass: silent ? truncated.length <= THRESHOLDS.maxTruncated : null,
			value: silent
				? `${truncated.length} truncated${truncated.length ? ` (first ${truncated[0].index}, last ${truncated.at(-1)?.index})` : ""}`
				: "n/a",
			threshold: silent ? `<= ${THRESHOLDS.maxTruncated}` : "n/a",
			note: vacuous,
		},
		{
			id: "C6 detection-lag",
			pass: silent ? lag <= THRESHOLDS.maxDetectionLag : null,
			value: silent
				? `${lag} truncated before ${detections.length ? `detection at call ${detections[0]}` : "any detection (none reported)"}`
				: "n/a",
			threshold: silent ? `<= ${THRESHOLDS.maxDetectionLag}` : "n/a",
			note: vacuous,
		},
		{
			id: "C7 false-detections",
			pass: reportsDetections ? falseAt.length === 0 : null,
			value: reportsDetections
				? `${falseAt.length}${falseAt.length ? ` (at ${falseAt.join(",")})` : ""} of ${detections.length} detections`
				: "n/a (engine reports no detections)",
			threshold: reportsDetections ? "0" : "n/a",
		},
		{
			id: "C8 named",
			pass: silent && reportsNames ? unnamed.length === 0 && unmatchedNames === 0 : null,
			value:
				silent && reportsNames
					? `${namedAt.length} named; ${truncated.length} truncated, ${visibleTruncated.length} outside the band${unnamed.length ? `; unnamed ${unnamed.slice(0, 8).join(",")}` : ""}${unnamedInBand.length ? `; unnamed in band ${unnamedInBand.slice(0, 8).join(",")}` : ""}${wronglyNamed.length ? `; named without truncation ${wronglyNamed.slice(0, 8).join(",")}` : ""}${unmatchedNames ? `; ${unmatchedNames} name(s) match no answer` : ""}`
					: "n/a",
			threshold:
				silent && reportsNames
					? `every truncation above ${flatness} + estimate error (at most ${THRESHOLDS.bandErrorCap}) named`
					: "n/a",
			note: vacuous,
		},
	];
	const budgets = calls.map(budgetAt).filter((b) => Number.isFinite(b));
	const engineStats: Record<string, unknown> = {
		cuts: stats.cuts.length,
		overflowRetries: stats.overflowRetries,
		capDecisions: stats.capDecisions,
		capped: stats.capped,
		imageEvictions: stats.imageEvictions,
		notices: stats.notices,
		alignMismatches: stats.alignMismatches,
		plateaus: stats.plateaus,
		learnedWindows: stats.learnedWindows,
		providerErrors: stats.providerErrors?.reduce<Record<string, number>>((acc, e) => {
			const key = `${e.class}: ${e.rule}`;
			acc[key] = (acc[key] ?? 0) + 1;
			return acc;
		}, {}),
		lastLimits: stats.lastLimits,
		lastRatio: stats.sent.at(-1)?.ratio,
		// The replay check's warnings, recorded only when there are any (normal runs have none).
		...(stats.replayWarnings?.length ? { replayWarnings: stats.replayWarnings } : {}),
		// N2: a misconfigured run reports the check's qualifying pairs and median share.
		...(config.replayMisconfigured ? { replayCheck: stats.replayChecks ?? {} } : {}),
	};
	return {
		id: config.id,
		config,
		engine: {
			label: engine.label,
			sha256: engine.sha256,
			source: engine.source,
			loaded: engine.loaded,
			via: engine.via,
		},
		tokenizer: input.tokenizerSource,
		corpusFingerprint: input.corpusFingerprint,
		session: {
			plannedTurns: input.plan.turns,
			answeredTurns: input.answered,
			abandonedTurns: input.abandoned,
			tasks: input.plan.tasks.length,
			classCounts: input.plan.classCounts,
			toolResultChars: input.plan.resultChars,
			promptErrors: input.promptErrors,
		},
		calls: n,
		alignment: {
			sentRecords: stats.sent.length,
			calls: n,
			ok: calls.every((c, i) => c.observed?.sentCount === i + 1),
		},
		limits: {
			hardLimit: config.limit,
			limitRule: config.limitRule,
			firstBudget: budgets[0],
			lastBudget: budgets.at(-1),
			minBudget: budgets.length ? Math.min(...budgets) : undefined,
			lastWindow: stats.lastLimits?.window,
		},
		rejections: {
			count: rejectedAt.length,
			late: late.length,
			at: rejectedAt,
			errorStyle: config.errorStyle,
			firstErrorText: calls.find((c) => c.rejected)?.errorText,
			allowance,
			reprobingEngine: reprobing,
			learnedLimits,
		},
		largest: {
			tokens: largestCall?.input ?? 0,
			at: largestIndex,
			budget: Math.round(budgetAt(largestCall)),
			shareOfBudget: round(shares[largestIndex]),
			shareOfHardLimit: round((largestCall?.input ?? 0) / config.limit),
		},
		share: {
			mean: round(meanShare),
			min: round(Math.min(...acceptedShares)),
			meanAfterFirstCut: meanAfterCut === null ? null : round(meanAfterCut),
			minAfterFirstCut: afterCut.length ? round(Math.min(...afterCut)) : null,
			p50: round(quantile(acceptedShares, 0.5)),
			p95: round(quantile(acceptedShares, 0.95)),
		},
		ratioTrace: { [`faux/e2-${config.window}`]: trace },
		cuts: { count: cutsTotal, at: cutAt },
		prefix: { breaks: breakAt.length, at: breakAt, breaksWithoutCut, cutsWithoutBreak, noticeTails },
		silent: silent
			? {
					truncated: truncated.length,
					at: truncated.map((c) => c.index),
					truncatedTokens: truncated.reduce((s, c) => s + c.truncatedTokens, 0),
					engineDetectedAt: detections,
					lagToDetection: detections.length ? truncated.filter((c) => c.index < detections[0]).length : null,
					lastTruncated: truncated.at(-1)?.index ?? null,
				}
			: null,
		falseDetections: reportsDetections ? { count: falseAt.length, at: falseAt } : null,
		named:
			silent && reportsNames
				? {
						at: namedAt,
						truncated: truncated.length,
						visible: visibleTruncated.length,
						unnamed,
						unnamedInBand,
						inBandTokens,
						wronglyNamed,
						unmatched: unmatchedNames,
					}
				: null,
		engineStats,
		images: {
			requestsWithImages: calls.filter((c) => c.images > 0).length,
			maxImageTokens: Math.max(0, ...calls.map((c) => c.imageTokens)),
		},
		criteria,
		verdict: criteria.some((c) => c.pass === false) ? "FAIL" : "PASS",
		runtimeMs: input.runtimeMs,
		tokenizerWork: input.tokenizerStats,
		notices: input.notices.slice(0, 20),
		series: {
			tokens: calls.map((c) => c.input),
			reported: calls.map((c) => (c.rejected ? null : c.processed)),
			budget: calls.map((c) => Math.round(budgetAt(c))),
			estimate: calls.map((c) => Math.round(c.observed?.estimate ?? Number.NaN)),
			ratio: calls.map((c) => round(c.observed?.ratio ?? Number.NaN)),
			flags: calls.map(
				(c, i) =>
					`${c.rejected ? "R" : ""}${c.truncated ? "T" : ""}${cutSet.has(i) ? "C" : ""}${breakSet.has(i) ? "B" : ""}${c.noticeTail ? "N" : ""}`,
			),
		},
	};
}
