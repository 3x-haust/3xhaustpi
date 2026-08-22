import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/tui-text.ts";
import { fitTranscriptCards } from "../src/tui-transcript.ts";

describe("compact conversation spacing", () => {
	it("keeps symmetric prompt padding before its neutral trailing row", () => {
		for (const columns of [56, 72, 80, 120]) {
			const rendered = fitTranscriptCards(["You 안녕"], columns, 12);
			const user = rendered.findIndex((line) => stripAnsi(line).includes("안녕"));
			expect(stripAnsi(rendered[user - 1] ?? ""), `${columns}-column prompt top padding`).toBe(" ".repeat(columns));
			expect(stripAnsi(rendered[user + 1] ?? ""), `${columns}-column prompt bottom padding`).toBe(
				" ".repeat(columns),
			);
			expect(rendered[user + 1], `${columns}-column tinted prompt bottom padding`).toContain("\u001b[48;5;238m");
			expect(rendered[user + 2], `${columns}-column prompt-only neutral trailing row`).toBe("");
		}
	});

	it("keeps one leading and trailing row around prompt and answer bodies", () => {
		for (const columns of [56, 72, 80, 120]) {
			const rendered = fitTranscriptCards(["You 안녕", "3xhaustPi 안녕하세요."], columns, 12);
			const lines = rendered.map((line) => stripAnsi(line));
			const user = lines.findIndex((line) => line.includes("안녕") && !line.includes("안녕하세요"));
			const assistant = lines.findIndex((line) => line.includes("안녕하세요"));

			expect(user, `${columns}-column user leading padding`).toBeGreaterThan(0);
			expect(assistant - user, `${columns}-column card boundary`).toBe(3);
			expect(lines[user - 1]?.trim(), `${columns}-column user leading row`).toBe("");
			expect(lines[user + 1]?.trim(), `${columns}-column user trailing row`).toBe("");
			expect(rendered[user + 1], `${columns}-column tinted prompt bottom padding`).toContain("\u001b[48;5;238m");
			expect(rendered[user + 2], `${columns}-column neutral prompt→answer row`).toBe("");
			expect(lines[assistant - 1]?.trim(), `${columns}-column assistant leading row`).toBe("");
			expect(lines[assistant + 1]?.trim(), `${columns}-column assistant trailing row`).toBe("");
		}
	});
});
