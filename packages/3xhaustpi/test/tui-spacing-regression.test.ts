import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../src/tui-text.ts";
import { fitTranscriptCards } from "../src/tui-transcript.ts";

let inheritedNoColor: string | undefined;
let inheritedTerm: string | undefined;

beforeEach(() => {
	inheritedNoColor = process.env.NO_COLOR;
	inheritedTerm = process.env.TERM;
	delete process.env.NO_COLOR;
	process.env.TERM = "xterm-256color";
});

afterEach(() => {
	if (inheritedNoColor === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = inheritedNoColor;
	if (inheritedTerm === undefined) delete process.env.TERM;
	else process.env.TERM = inheritedTerm;
});

describe("compact conversation spacing", () => {
	it("keeps the user role visible when color is unavailable", () => {
		const previousNoColor = process.env.NO_COLOR;
		process.env.NO_COLOR = "1";
		try {
			const rendered = fitTranscriptCards(["You 안녕"], 56, 12);
			expect(rendered).toContain("> 안녕");
			expect(rendered.join("")).not.toContain("\u001b[");
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
		}
	});

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

	it("keeps one neutral row between an answer and the next prompt", () => {
		for (const columns of [56, 72, 80, 120]) {
			const rendered = fitTranscriptCards(["3xhaustPi 이전 응답입니다.", "You 다음 질문입니다."], columns, 12);
			const lines = rendered.map((line) => stripAnsi(line));
			const assistant = lines.findIndex((line) => line.includes("이전 응답"));
			const user = lines.findIndex((line) => line.includes("다음 질문"));

			expect(user - assistant, `${columns}-column answer→prompt boundary`).toBe(3);
			expect(rendered[assistant + 1], `${columns}-column neutral answer trailing row`).toBe("");
			expect(lines[assistant + 2], `${columns}-column prompt leading padding`).toBe(" ".repeat(columns));
			expect(rendered[assistant + 2], `${columns}-column tinted prompt leading padding`).toContain(
				"\u001b[48;5;238m",
			);
		}
	});
});
