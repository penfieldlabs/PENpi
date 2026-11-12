import { describe, expect, it } from "vitest";
import { type AgentMessage, messageRunSlack, textTokens, textTokensFloor } from "./estimator.ts";

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
		for (const text of ["const x = 1;\nreturn x;", "aaaaaaaa 00000000", `a${" ".repeat(40)}b\t\t\t\tc`, "..."])
			expect(textTokensFloor(text)).toBe(textTokens(text));
	});

	it("the floor is never above textTokens", () => {
		for (const text of ["....", "a....b", "-".repeat(5), `${"#".repeat(70)} 100%`, "x"])
			expect(textTokensFloor(text)).toBeLessThanOrEqual(textTokens(text));
	});
});

describe("E3.5: a message's run slack", () => {
	const slack = (text: string) => textTokens(text) - textTokensFloor(text);

	it("is textTokens less the floor over the text a message sends", () => {
		const report = unittest(2_000);
		const result = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: report }] };
		expect(messageRunSlack(result as unknown as AgentMessage)).toBe(slack(report));
		const bash = { role: "bashExecution", command: "pytest -q", output: report };
		expect(messageRunSlack(bash as unknown as AgentMessage)).toBe(slack(`pytest -q\n${report}`));
		const call = {
			role: "assistant",
			content: [
				{ type: "text", text: "Writing the rule." },
				{ type: "toolCall", name: "write", arguments: { text: "=".repeat(400) } },
			],
		};
		expect(messageRunSlack(call as unknown as AgentMessage)).toBe(slack(JSON.stringify({ text: "=".repeat(400) })));
		expect(messageRunSlack(call as unknown as AgentMessage)).toBeGreaterThan(200);
	});

	it("is 0 for a message without runs", () => {
		const user = { role: "user", content: "Run the tests and report." };
		expect(messageRunSlack(user as unknown as AgentMessage)).toBe(0);
	});
});
