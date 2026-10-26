/**
 * Opt-in engine log and per-request telemetry (what the release-gate benchmark collects per unit). Both are
 * off unless PENPI_ENGINE_LOG names a file:
 *   - the engine's own log lines, one per line with an ISO timestamp;
 *   - one telemetry report per request, written to the same file ("telemetry {json}") and emitted as the
 *     status `context-engine.telemetry`.
 * Neither carries prompt or message text: the engine's lines hold ids, sizes, ratios and decisions, and the
 * provider error text two of them quote (which may echo request content) is replaced by its length.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./estimator.ts";
import { type EngineStats, NOTICE_MARKER, NOTICE_TYPE } from "./options.ts";

export const ENGINE_LOG_ENV = "PENPI_ENGINE_LOG";
export const TELEMETRY_STATUS = "context-engine.telemetry";

/**
 * A log line without provider text. Two of the engine's lines quote a provider's error message (which may
 * contain request content, and quotes of its own): `provider error (...): "..."` and `overflow: "..." limit=`.
 * Everything from their first to their last quote becomes `[N chars]`. The other lines hold only ids, sizes,
 * ratios and decisions.
 */
export function redactQuoted(line: string): string {
	if (!/\] (provider error \(|overflow: ")/.test(line)) return line;
	const first = line.indexOf('"');
	const last = line.lastIndexOf('"');
	if (first < 0 || last <= first) return line;
	return `${line.slice(0, first)}[${last - first - 1} chars]${line.slice(last + 1)}`;
}

/** The file behind PENPI_ENGINE_LOG: engine lines (quoted text redacted) and telemetry reports. */
export interface EngineLogWriter {
	line: (line: string) => void;
	/** A telemetry report: built from counts, sizes and engine-made labels only, so written as is. */
	report: (json: string) => void;
}

/** Write failures never reach the engine. */
export function engineLogWriter(path: string): EngineLogWriter {
	const append = (text: string) => {
		try {
			appendFileSync(path, `${new Date().toISOString()} ${text}\n`);
		} catch {}
	};
	return { line: (line) => append(redactQuoted(line)), report: (json) => append(`telemetry ${json}`) };
}

function isNotice(message: AgentMessage | undefined): boolean {
	const m = message as { role?: string; customType?: string; content?: unknown } | undefined;
	if (!m || m.role !== "custom") return false;
	if (m.customType === NOTICE_TYPE) return true;
	return typeof m.content === "string" && m.content.startsWith(NOTICE_MARKER);
}

/**
 * Per-request telemetry: request number, whether the request ends with the pre-cut notice, message count,
 * cuts, notices, silent-truncation detections, the refusal flag, the pin's estimated tokens, the limits when
 * they change, and the active tool names on the first request.
 * Registered after the engine, so it sees the request the engine produced.
 */
export function installTelemetry(pi: ExtensionAPI, stats: EngineStats, write: (json: string) => void): void {
	let requests = 0;
	let lastLimits = "";
	pi.on("context_with_system", (event, ctx) => {
		requests++;
		const messages = event.messages as AgentMessage[];
		const limits = stats.lastLimits ? JSON.stringify(stats.lastLimits) : "";
		const report: Record<string, unknown> = {
			k: "req",
			n: requests,
			notice: isNotice(messages.at(-1)),
			msgs: messages.length,
			cuts: stats.cuts.length,
			notices: stats.notices,
			silent: stats.plateaus.length,
			refused: stats.refused,
			pin: stats.pinTokens.at(-1),
		};
		if (limits !== lastLimits) {
			report.limits = stats.lastLimits;
			lastLimits = limits;
		}
		if (requests === 1) {
			try {
				report.tools = pi.getActiveTools();
			} catch {}
		}
		const json = JSON.stringify(report);
		write(json);
		try {
			ctx.ui.setStatus(TELEMETRY_STATUS, json);
		} catch {}
		return undefined;
	});
}
