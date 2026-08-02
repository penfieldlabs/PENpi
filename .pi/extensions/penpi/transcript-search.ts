/**
 * Tier 3 — transcript search.
 *
 * Pi keeps a verbatim JSONL log per session under
 *   <agentDir>/sessions/<encoded-cwd>/*.jsonl
 * This is the safety net for everything that rolls out of the FIFO window
 * (Tier 1) and was never deliberately stored to Penfield (Tier 2). This module
 * searches those logs so the agent can actually reach Tier 3.
 *
 * READ-ONLY. It never writes or deletes session files.
 *
 * `searchTranscripts` is pure (operates on a given directory) so it can be
 * unit-tested against fixtures without touching real sessions.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TranscriptMatch {
	/** Session file basename. */
	file: string;
	/** Entry timestamp (epoch ms or ISO), if present. */
	timestamp: number | string | null;
	/** Role / entry kind (user, assistant, toolResult, custom:..., etc.). */
	role: string;
	/** Snippet of text around the match. */
	snippet: string;
}

export interface TranscriptSearchResult {
	matches: TranscriptMatch[];
	filesSearched: number;
	dir: string;
	truncated: boolean;
}

/**
 * Resolve the session-log directory for a cwd, replicating pi's encoding
 * (see getDefaultSessionDirPath in core/session-manager.ts). Read-only — does
 * not create the directory.
 */
export function sessionDirForCwd(cwd: string, agentDir: string = getAgentDir()): string {
	const safe = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return resolve(agentDir, "sessions", safe);
}

function blockText(b: unknown): string {
	if (typeof b === "string") return b;
	if (!b || typeof b !== "object") return "";
	const o = b as Record<string, unknown>;
	if (typeof o.text === "string") return o.text;
	if (typeof o.thinking === "string") return o.thinking;
	if (o.type === "toolCall") return `[tool ${String(o.name ?? "")} ${JSON.stringify(o.arguments ?? {})}]`;
	if (Array.isArray(o.content)) return o.content.map(blockText).join(" ");
	if (typeof o.content === "string") return o.content;
	return "";
}

/** Extract a human-readable role + text from a parsed session entry. */
function entryText(entry: Record<string, unknown>): { role: string; text: string; ts: number | string | null } {
	const m = (entry.message as Record<string, unknown>) ?? entry;
	const ts = (entry.timestamp ?? m.timestamp ?? null) as number | string | null;
	const role =
		entry.type === "custom_message" || entry.type === "custom"
			? `custom:${String(entry.customType ?? m.customType ?? "")}`
			: String(m.role ?? entry.role ?? entry.type ?? "?");

	const parts: string[] = [];
	const content = m.content ?? entry.content;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) parts.push(content.map(blockText).join("\n"));
	if (typeof m.summary === "string") parts.push(m.summary);
	if (typeof m.command === "string" || typeof m.output === "string") {
		parts.push(`$ ${String(m.command ?? "")}\n${String(m.output ?? "")}`);
	}
	let text = parts.filter(Boolean).join("\n").trim();
	if (!text) text = JSON.stringify(m);
	return { role, text, ts };
}

function makeSnippet(text: string, idx: number, query: number): string {
	const start = Math.max(0, idx - 100);
	const end = Math.min(text.length, idx + query + 100);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Search every *.jsonl in `dir` (newest file first) for `query` (case-insensitive
 * substring). Streams line-by-line so a large session log is never read fully into
 * memory, and stops as soon as `limit` matches are found.
 */
export async function searchTranscripts(
	dir: string,
	query: string,
	opts: { limit?: number; excludeFile?: string } = {},
): Promise<TranscriptSearchResult> {
	const limit = opts.limit ?? 10;
	const q = query.toLowerCase();
	const matches: TranscriptMatch[] = [];
	let filesSearched = 0;
	let truncated = false;

	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl") && f !== opts.excludeFile)
			.map((f) => ({ f, m: safeMtime(resolve(dir, f)) }))
			.sort((a, b) => b.m - a.m)
			.map((x) => x.f);
	} catch {
		return { matches, filesSearched: 0, dir, truncated: false };
	}

	for (const file of files) {
		if (matches.length >= limit) {
			truncated = true;
			break;
		}
		filesSearched++;
		const stream = createReadStream(resolve(dir, file), "utf8");
		try {
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (matches.length >= limit) {
					truncated = true;
					break; // closes the readline iterator + stops reading this file
				}
				if (!line.trim()) continue;
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				const { role, text, ts } = entryText(entry);
				const idx = text.toLowerCase().indexOf(q);
				if (idx >= 0) matches.push({ file, timestamp: ts, role, snippet: makeSnippet(text, idx, query.length) });
			}
		} catch {
			// unreadable file — skip
		} finally {
			stream.destroy();
		}
	}
	return { matches, filesSearched, dir, truncated };
}

function safeMtime(p: string): number {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}
