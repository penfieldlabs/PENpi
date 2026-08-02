import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchTranscripts, sessionDirForCwd } from "./transcript-search.ts";

function fixtureDir(files: Record<string, string[]>): string {
	const dir = mkdtempSync(join(tmpdir(), "penpi-tx-"));
	for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines.join("\n"));
	return dir;
}

const msg = (role: string, text: string, ts?: number) =>
	JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: ts } });

describe("sessionDirForCwd", () => {
	it("replicates pi's cwd encoding", () => {
		expect(sessionDirForCwd("/home/user/projects/demo-app", "/tmp/agent")).toBe(
			"/tmp/agent/sessions/--home-user-projects-demo-app--",
		);
	});
});

describe("searchTranscripts", () => {
	it("finds a case-insensitive match with role + snippet", async () => {
		const dir = fixtureDir({
			"a.jsonl": [msg("user", "the secret NEEDLE is in the haystack", 1000), msg("assistant", "unrelated reply")],
		});
		const r = await searchTranscripts(dir, "needle");
		expect(r.matches).toHaveLength(1);
		expect(r.matches[0].role).toBe("user");
		expect(r.matches[0].snippet.toLowerCase()).toContain("needle");
		expect(r.filesSearched).toBe(1);
	});

	it("searches custom_message entries (e.g. injected briefing)", async () => {
		const dir = fixtureDir({
			"a.jsonl": [
				JSON.stringify({
					type: "custom_message",
					customType: "penpi-briefing",
					content: "orientation payload",
					timestamp: 5,
				}),
			],
		});
		const r = await searchTranscripts(dir, "orientation");
		expect(r.matches).toHaveLength(1);
		expect(r.matches[0].role).toBe("custom:penpi-briefing");
	});

	it("respects limit and flags truncation", async () => {
		const dir = fixtureDir({ "a.jsonl": Array.from({ length: 5 }, (_, i) => msg("user", `hit ${i} match`)) });
		const r = await searchTranscripts(dir, "match", { limit: 2 });
		expect(r.matches).toHaveLength(2);
		expect(r.truncated).toBe(true);
	});

	it("returns nothing for no match", async () => {
		const dir = fixtureDir({ "a.jsonl": [msg("user", "nothing here")] });
		expect((await searchTranscripts(dir, "zzz")).matches).toHaveLength(0);
	});

	it("skips malformed lines and missing dirs gracefully", async () => {
		const dir = fixtureDir({ "a.jsonl": ["not json", "", msg("user", "valid needle")] });
		expect((await searchTranscripts(dir, "needle")).matches).toHaveLength(1);
		expect((await searchTranscripts("/no/such/dir", "x")).matches).toHaveLength(0);
	});
});
