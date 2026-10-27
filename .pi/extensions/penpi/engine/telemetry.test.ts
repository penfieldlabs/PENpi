import { describe, expect, it } from "vitest";
import { redactQuoted } from "./telemetry.ts";

describe("engine log redaction", () => {
	it("replaces a provider's error text, quotes inside it included, with its length", () => {
		const error = '{"error":{"message":"prompt is too long: SECRET request text \\"quoted\\""}}';
		const line = `[a] provider error (context-overflow; anthropic prompt too long): "${error}" -> window 30000`;
		const out = redactQuoted(line);
		expect(out).toBe(
			`[a] provider error (context-overflow; anthropic prompt too long): [${error.length} chars] -> window 30000`,
		);
		expect(out).not.toContain("SECRET");
	});

	it("redacts the overflow line's quoted error and keeps its numbers", () => {
		const out = redactQuoted(
			'[a] overflow: "maximum context length is 32768 tokens; your messages: SECRET" limit=32768 requested=40000 sent=39000 window 32768 -> 30000',
		);
		expect(out).toMatch(/^\[a\] overflow: \[\d+ chars\] limit=32768 requested=40000 /);
		expect(out).not.toContain("SECRET");
	});

	it("leaves the engine's other lines alone", () => {
		const line = '[a] state loaded models=[["faux/faux-32k",1.045,50,null]] caps=0 seq=3';
		expect(redactQuoted(line)).toBe(line);
	});
});
