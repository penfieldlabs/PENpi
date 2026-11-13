import { describe, expect, it } from "vitest";
import { type AgentMessage, messageFloorSlack, textTokens, textTokensFloor } from "./estimator.ts";

const unittest = (tests: number) => `${".".repeat(tests)}\n${"-".repeat(70)}\nRan ${tests} tests in 41.512s\n\nOK\n`;

describe("E3.5: the growth check's floor counts a run of one character as a run", () => {
	it("a run costs 1 + length / 64, where textTokens charges every character", () => {
		// o200k and GLM-5.3-Flash count 2,000 dots as 32 tokens.
		expect(textTokens(".".repeat(2_000))).toBe(1_285);
		expect(textTokensFloor(".".repeat(2_000))).toBe(33);
		expect(textTokensFloor("=".repeat(80))).toBe(3);
		// The rest of the text is counted as textTokens counts it.
		const report = unittest(600);
		expect(textTokensFloor(report)).toBe(
			Math.ceil(textTokens("\n\nRan 600 tests in 41.512s\n\nOK\n") + 2 + 670 / 64),
		);
	});

	it("text without such runs keeps its estimate: letters, digits, spaces and tabs are not runs", () => {
		for (const text of ["const x = 1;\nreturn x;", "aaaaaaaa 00000000", "a    b\t\t\t\tc   d e", "..."])
			expect(textTokensFloor(text)).toBe(textTokens(text));
	});

	it("the floor is never above textTokens", () => {
		for (const text of [
			"....",
			"a....b",
			"-".repeat(5),
			`${"#".repeat(70)} 100%`,
			"x",
			"A".repeat(4_000),
			"-=".repeat(9),
		])
			expect(textTokensFloor(text)).toBeLessThanOrEqual(textTokens(text));
	});
});

describe("E3.5: a message's floor slack", () => {
	const slack = (text: string) => textTokens(text) - textTokensFloor(text);

	it("is textTokens less the floor over the text a message sends", () => {
		const report = unittest(2_000);
		const result = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: report }] };
		expect(messageFloorSlack(result as unknown as AgentMessage)).toBe(slack(report));
		const bash = { role: "bashExecution", command: "pytest -q", output: report };
		expect(messageFloorSlack(bash as unknown as AgentMessage)).toBe(slack(`pytest -q\n${report}`));
		const call = {
			role: "assistant",
			content: [
				{ type: "text", text: "Writing the rule." },
				{ type: "toolCall", name: "write", arguments: { text: "=".repeat(400) } },
			],
		};
		expect(messageFloorSlack(call as unknown as AgentMessage)).toBe(slack(JSON.stringify({ text: "=".repeat(400) })));
		expect(messageFloorSlack(call as unknown as AgentMessage)).toBeGreaterThan(200);
	});

	it("is 0 for a message without runs", () => {
		const user = { role: "user", content: "Run the tests and report." };
		expect(messageFloorSlack(user as unknown as AgentMessage)).toBe(0);
	});
});

describe("E3.5: the floor bounds other repetition by its deflated size", () => {
	// Real tokens, o200k and GLM-5.3-Flash alike: base64 of 3,000 zero bytes 500, 60 lines of `-=` x35 420,
	// 60 lines of `x` x70 659. The floor must stay below twice the real count, or an honest append reads as half missing.
	const lines = (line: string) => Array.from({ length: 60 }, () => line).join("\n");

	it("base64 and hex of zeros, letter runs and `-=` rules fall far below textTokens, and stay under twice the real count", () => {
		const zeros = Buffer.alloc(3_000).toString("base64");
		expect(textTokens(zeros)).toBe(2_677);
		expect(textTokensFloor(zeros)).toBe(45);
		expect(textTokensFloor(Buffer.alloc(2_000).toString("hex"))).toBe(45);
		expect(textTokens(lines("-=".repeat(35)))).toBe(2_738);
		expect(textTokensFloor(lines("-=".repeat(35)))).toBe(120);
		expect(textTokensFloor(lines("x".repeat(70)))).toBe(113);
	});

	it("random base64, a hash and a short table rule keep their estimate", () => {
		let seed = 1;
		const next = () => {
			seed = (seed * 1103515245 + 12345) >>> 0;
			return seed >>> 24;
		};
		const random = Buffer.from(Array.from({ length: 3_000 }, next)).toString("base64");
		expect(textTokensFloor(random)).toBe(textTokens(random));
		const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		expect(textTokensFloor(sha)).toBe(textTokens(sha));
		expect(textTokensFloor("|---|---|---|")).toBe(textTokens("|---|---|---|"));
	});

	it("text that is mostly spaces is counted at its class costs, without textTokens' bound of length / 8", () => {
		const padded = `${" ".repeat(4_000)}end`;
		expect(textTokens(padded)).toBe(501);
		expect(textTokensFloor(padded)).toBe(2);
	});

	it("a message's slack includes it", () => {
		const blob = `${Buffer.alloc(3_000).toString("base64")}\n`;
		const result = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: blob }] };
		expect(messageFloorSlack(result as unknown as AgentMessage)).toBe(textTokens(blob) - textTokensFloor(blob));
		expect(messageFloorSlack(result as unknown as AgentMessage)).toBeGreaterThan(2_500);
	});
});

describe("E3.5: the floor prices runs of a short period, whitespace and control characters included", () => {
	it("blank CRLF lines and lines of one tab or one space fall far below textTokens", () => {
		// Real tokens, o200k and GLM-5.3-Flash alike: 1,500 blank CRLF lines about 375.
		const crlf = `Output:\r\n${"\r\n".repeat(1_500)}Done.\r\n`;
		expect(textTokens(crlf)).toBe(1_970);
		expect(textTokensFloor(crlf)).toBe(52);
		expect(textTokensFloor("\t\n".repeat(1_500))).toBe(48);
		expect(textTokensFloor(" \n".repeat(1_500))).toBe(48);
		// A unit of 8 and its CRLF: a period of 10.
		expect(textTokensFloor("\r\n\r\n\r\n\t\r\n".repeat(200))).toBe(30);
	});

	it("a period across classes costs half a token per change of class: `!` lines are one token each", () => {
		expect(textTokensFloor("!\r\n".repeat(500))).toBe(500);
	});

	it("next to sparse data, both are taken off", () => {
		const text = `${"\r\n".repeat(500)}${Buffer.alloc(3_000).toString("base64")}`;
		expect(textTokensFloor(text)).toBe(62);
	});

	it("short repetition keeps its estimate; letters alone and spaces and tabs alone keep the other arms' floor", () => {
		expect(textTokensFloor("\t});\n\t});\n")).toBe(textTokens("\t});\n\t});\n"));
		expect(textTokensFloor("|---|---|---|---|---|")).toBe(textTokens("|---|---|---|---|---|"));
		// The base64 segments' floor, as before the arm.
		expect(textTokensFloor("abab".repeat(50))).toBe(15);
		// The class costs' floor, as before the arm.
		expect(textTokensFloor(" \t".repeat(100))).toBe(2);
	});
});
