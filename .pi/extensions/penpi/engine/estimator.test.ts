import { describe, expect, it } from "vitest";
import { type AgentMessage, FLOOR_FREE, messageFloorSlack, textTokens, textTokensFloor } from "./estimator.ts";

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
		// Real tokens, o200k and GLM-5.3-Flash alike: 1,500 blank CRLF lines about 375. CR costs nothing (FLOOR_FREE), so
		// the floor is that of the LF lines.
		const crlf = `Output:\r\n${"\r\n".repeat(1_500)}Done.\r\n`;
		expect(textTokens(crlf)).toBe(1_970);
		expect(textTokensFloor(crlf)).toBe(28);
		expect(textTokensFloor("\t\n".repeat(1_500))).toBe(48);
		expect(textTokensFloor(" \n".repeat(1_500))).toBe(48);
		// A unit of 8 and its CRLF: a period of 10, and of 5 without the CRs.
		expect(textTokensFloor("\r\n\r\n\r\n\t\r\n".repeat(200))).toBe(17);
	});

	it("a period across classes costs half a token per change of class: `!` lines are one token each", () => {
		expect(textTokensFloor("!\r\n".repeat(500))).toBe(500);
	});

	it("next to sparse data, both are taken off", () => {
		const text = `${"\r\n".repeat(500)}${Buffer.alloc(3_000).toString("base64")}`;
		expect(textTokensFloor(text)).toBe(54);
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

describe("E3.5: the floor prices whitespace that holds a line break, with no period needed", () => {
	it("blank lines between short lines fall far below textTokens", () => {
		// A counter line, then 7 blank CRLF lines, 400 times: real tokens about 1,200 (o200k and GLM). The floors are those
		// of the LF lines (FLOOR_FREE).
		const counter = Array.from({ length: 400 }, (_, i) => `${i}${"\r\n".repeat(8)}`).join("");
		expect(textTokens(counter)).toBe(5_024);
		expect(textTokensFloor(counter)).toBe(1_180);
		const blank14 = Array.from({ length: 150 }, (_, i) => `ok ${i}\r\n${"\r\n".repeat(14)}`).join("");
		expect(textTokensFloor(blank14)).toBe(566);
	});

	it("trailing whitespace before a break counts as such a run", () => {
		const trailing = Array.from({ length: 300 }, (_, i) => `x${i}${" ".repeat(i % 7)}\n`).join("");
		expect(textTokens(trailing)).toBe(1_170);
		expect(textTokensFloor(trailing)).toBe(1_047);
		expect(textTokensFloor("ok  \n\nok")).toBe(2);
	});

	it("one break and the indentation after it, as ordinary code has, keeps its estimate", () => {
		for (const text of ["function f() {\n\tconst a = 1;\n\treturn a;\n}\n", "a\n    b\n\t\tc\n"])
			expect(textTokensFloor(text)).toBe(textTokens(text));
	});

	it("an indentation of no-break and ordinary spaces in turn, as HTML writes a run of spaces, costs as a run of breaks", () => {
		const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
		const lines = (k: number, first: string, second: string) =>
			rep(400, (i) => `x${i % 10}\n${rep(k, (j) => (j % 2 ? second : first))}`);
		// At every depth below the period arm's 32 characters, either order; textTokens prices each character there.
		for (const [k, floor] of [
			[4, 688],
			[16, 988],
			[30, 1_338],
			[31, 1_363],
		] as const) {
			expect(textTokensFloor(lines(k, "\u00a0", " "))).toBe(floor);
			expect(textTokensFloor(lines(k, " ", "\u00a0"))).toBe(floor);
		}
		expect(textTokens(lines(30, "\u00a0", " "))).toBe(8_819);
		// From 32 the period arm takes the run, as before.
		expect(textTokensFloor(lines(60, "\u00a0", " "))).toBe(1_372);
		// A short one keeps its class costs where they are below the break-run price.
		expect(textTokensFloor("a\n\u00a0b")).toBe(textTokens("a\n\u00a0b"));
	});

	it("a marker that starts a line, or a run that ends one, is priced with the breaks after it", () => {
		const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
		// `//` comment lines between blank lines: 1,500 o200k tokens, 3,566 by textTokens and the arms before this.
		const slashes = rep(1500, (i) => ["//\n", "// \n", "//\n\n"][i % 3]);
		expect(textTokens(slashes)).toBe(3_566);
		expect(textTokensFloor(slashes)).toBe(2_219);
		// Ellipsis runs between blank CRLF lines: 1,025 o200k tokens, 2,114 by the arms before this, 515 with them, and 431
		// without the CRs (FLOOR_FREE).
		const ellipsis = rep(300, (i) => `${"…".repeat(4 + (i % 12))}${"\r\n".repeat(2 + (i % 6))}`);
		expect(textTokensFloor(ellipsis)).toBe(431);
	});

	it("an indented marker, a marker of 4 or more, and a run with text after it keep the floor they had", () => {
		const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
		// The values on the floor before markers and runs at a line's end were priced with its breaks.
		expect(textTokensFloor(rep(300, () => "\t}\n\n"))).toBe(300);
		expect(textTokensFloor(rep(300, () => "////\n\n"))).toBe(300);
		expect(textTokensFloor(rep(300, (i) => `// c${i}\n\n`))).toBe(1_600);
		expect(textTokensFloor(rep(300, (i) => `${"─".repeat(16)} x${i}\n`))).toBe(1_393);
		const code = "function f() {\n\tif (a) {\n\t\treturn 1;\n\t}\n}\n\n// done\n";
		expect(textTokensFloor(code)).toBe(textTokens(code));
	});
});

describe("E3.5: the floor's time on a long run with no line break after it", () => {
	it("a 100,000-character run of one letter takes well under a second, at the end of the text or before other text", () => {
		// The pattern for a run that ends a line once had its line-break test as a lookahead, retried from every position
		// of such a run: about 30 s for this text.
		for (const text of ["é".repeat(100_000), `${"é".repeat(100_000)}x`, `${"ㅋ".repeat(100_000)} y`]) {
			const start = performance.now();
			textTokensFloor(text);
			expect(performance.now() - start).toBeLessThan(1_000);
		}
	});
});

describe("E3.5: the floor prices at zero the characters Claude's tokenizers drop", () => {
	it("the set: the C0 controls but NUL, TAB and LF, DEL, and the C1 controls", () => {
		const free: number[] = [];
		for (let c = 0; c < 0x10000; c++) if (String.fromCharCode(c).replace(FLOOR_FREE, "") === "") free.push(c);
		const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
		expect(free).toEqual([...range(0x01, 0x08), ...range(0x0b, 0x1f), ...range(0x7f, 0x9f)]);
	});

	it("text made only of them has a floor of 0; with other text it is priced as that text, and never above it", () => {
		expect(textTokensFloor("\u0001\u0013\u001b\u007f\u0085".repeat(1_000))).toBe(0);
		// Progress lines that each start with a carriage return, test output with color codes, a CRLF file.
		const progress = Array.from({ length: 200 }, (_, i) => `\r[${"#".repeat(i % 40).padEnd(40)}] ${i % 100}%`).join(
			"",
		);
		const color = Array.from({ length: 300 }, (_, i) => `\x1b[32m✓\x1b[0m test ${i} passed\n`).join("");
		const crlf = Array.from({ length: 300 }, (_, i) => `line ${i}: const value = compute(${i});\r\n`).join("");
		for (const text of [progress, color, crlf])
			expect(textTokensFloor(text)).toBe(textTokensFloor(text.replace(FLOOR_FREE, "")));
		expect([textTokensFloor(progress), textTokensFloor(color), textTokensFloor(crlf)]).toEqual([1_171, 2_941, 3_813]);
	});

	it("every C1 control costs nothing, not only NEL: 32 of them, 100 times over, have a floor of 0", () => {
		const c1 = Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
		expect(textTokensFloor(c1.repeat(100))).toBe(0);
	});

	it("runs of U+2028 and spaces cost as runs of breaks: Claude merges them, with no character it drops", () => {
		let seed = 24_681_357;
		const pick = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return ["\u2028", " ", " "][Math.floor((seed / 2_147_483_648) * 3)];
		};
		const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("");
		// The sweep's two shapes, with the same mix (not the sweep's texts): Claude counts the sweep's texts at 125 and 800
		// in every group. The floors of these were 1,018 and 3,422 before.
		const random = rep(2_000, pick);
		const counter = rep(400, (i) => `${i}${rep(12, pick)}`);
		expect(textTokensFloor(random)).toBe(127);
		expect(textTokensFloor(counter)).toBe(1_531);
	});

	it("runs of NUL and spaces cost as whitespace runs: Claude merges them (1,000 NUL count 63)", () => {
		expect(textTokens(" \u0000 ".repeat(1_000))).toBe(2_139);
		expect(textTokensFloor(" \u0000 ".repeat(1_000))).toBe(48);
	});
});
