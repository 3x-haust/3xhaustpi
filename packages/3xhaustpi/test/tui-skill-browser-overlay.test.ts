import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SkillResource } from "../src/resource-loader.ts";
import { startSkillBrowser } from "../src/tui-live-resources.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { SkillBrowserOverlay } from "../src/tui-skill-browser-overlay.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

const skills: readonly SkillResource[] = [
	{
		id: "debugging",
		name: "Debugging",
		description: "Trace runtime failures from evidence.",
		instructions: "Form hypotheses.\nConfirm the root cause.\nLock the fix with a regression test.",
		scope: "builtin",
		sourcePath: "/skills/debugging/SKILL.md",
		sha256: "debug",
	},
	{
		id: "한국어",
		name: "한국어 검수",
		description: "한글 출력의 셀 너비와 줄바꿈을 확인합니다.",
		instructions: "모든 화면 크기에서 잘림 없이 표시합니다.",
		scope: "project",
		sourcePath: "/project/.3xhaust/skills/korean/SKILL.md",
		sha256: "korean",
	},
];

function harness(): {
	readonly overlay: SkillBrowserOverlay;
	readonly closed: () => boolean;
} {
	let isClosed = false;
	return {
		overlay: new SkillBrowserOverlay(skills, () => 12, {
			close: () => {
				isClosed = true;
			},
			invalidate: () => {},
		}),
		closed: () => isClosed,
	};
}

describe("SkillBrowserOverlay", () => {
	it("lists installed skills with scope and description", () => {
		const rendered = stripAnsi(harness().overlay.render(72).join("\n"));

		expect(rendered).toContain("Installed skills");
		expect(rendered).toContain("Debugging");
		expect(rendered).toContain("builtin");
		expect(rendered).toContain("Trace runtime failures");
		expect(rendered).toContain("한국어 검수");
	});

	it("opens complete instructions and returns before closing", () => {
		const context = harness();

		context.overlay.handleInput("\r");
		expect(stripAnsi(context.overlay.render(72).join("\n"))).toContain("Lock the fix with a regression test.");
		context.overlay.handleInput("\u001b");
		expect(stripAnsi(context.overlay.render(72).join("\n"))).toContain("Installed skills");
		expect(context.closed()).toBe(false);
		context.overlay.handleInput("\u001b");
		expect(context.closed()).toBe(true);
	});

	it("keeps CJK detail and every row inside compact bounds", () => {
		const context = harness();
		const list = stripAnsi(context.overlay.render(36).join("\n"));
		expect(list).toContain("project");
		expect(list).toContain("한글");
		context.overlay.handleInput("\u001b[B");
		context.overlay.handleInput("\r");

		const lines = context.overlay.render(36);

		expect(stripAnsi(lines.join("\n"))).toContain("모든 화면 크기에서");
		expect(stripAnsi(lines.join("\n"))).toContain("q close");
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines.every((line) => cellWidth(stripAnsi(line)) <= 36)).toBe(true);
	});

	it("sanitizes terminal controls from list metadata and detail titles", () => {
		const base = skills[0];
		if (!base) throw new Error("Expected malicious skill fixture base");
		const malicious: readonly SkillResource[] = [
			{
				...base,
				name: "Safe\u001b[2JName",
				description: "Visible\u001b]0;PWNED\u0007 description",
			},
		];
		const overlay = new SkillBrowserOverlay(malicious, () => 12, {
			close: () => {},
			invalidate: () => {},
		});

		const list = overlay.render(72).join("\n");
		overlay.handleInput("\r");
		const detail = overlay.render(72).join("\n");

		expect(list).not.toContain("\u001b[2J");
		expect(list).not.toContain("\u001b]0;");
		expect(detail).not.toContain("\u001b[2J");
		expect(stripAnsi(`${list}\n${detail}`)).toContain("SafeName");
		expect(stripAnsi(list)).toContain("Visible description");
	});

	it("retains reverse-video selection when semantic color is disabled", () => {
		const inherited = process.env.NO_COLOR;
		const inheritedTerm = process.env.TERM;
		process.env.NO_COLOR = "1";
		process.env.TERM = "xterm-256color";
		try {
			expect(harness().overlay.render(72).join("\n")).toContain("\u001b[7m");
		} finally {
			if (inherited === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = inherited;
			if (inheritedTerm === undefined) delete process.env.TERM;
			else process.env.TERM = inheritedTerm;
		}
	});

	it("pages long Korean instructions without breaking terminal bounds", () => {
		const base = skills[1];
		if (!base) throw new Error("Expected Korean skill fixture base");
		const longSkill: readonly SkillResource[] = [
			{
				...base,
				instructions: "긴 한국어 지침을 정확한 셀 너비로 표시합니다. ".repeat(20),
			},
		];
		const overlay = new SkillBrowserOverlay(longSkill, () => 10, {
			close: () => {},
			invalidate: () => {},
		});
		overlay.handleInput("\r");
		const first = overlay.render(36);

		overlay.handleInput("\u001b[6~");
		const second = overlay.render(36);

		expect(second).not.toEqual(first);
		expect(second.every((line) => cellWidth(stripAnsi(line)) <= 36)).toBe(true);
	});

	it("reflows list and detail against live terminal height changes", () => {
		let rows = 12;
		const overlay = new SkillBrowserOverlay(skills, () => rows, {
			close: () => {},
			invalidate: () => {},
		});

		expect(overlay.render(72).length).toBeLessThanOrEqual(12);
		rows = 4;
		const compactList = overlay.render(72);
		expect(compactList.length).toBeLessThanOrEqual(4);
		expect(stripAnsi(compactList.at(-1) ?? "")).toContain("precedence");

		overlay.handleInput("\r");
		const compactDetail = overlay.render(72);
		expect(compactDetail.length).toBeLessThanOrEqual(4);
		expect(stripAnsi(compactDetail.at(-1) ?? "")).toMatch(/\d+\/\d+ rows/u);
	});

	it("sanitizes skill metadata before compact transcript fallback", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-skill-fallback-"));
		const projectRoot = join(root, "project");
		const skillRoot = join(projectRoot, ".3xhaust", "skills", "unsafe");
		const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		mkdirSync(skillRoot, { recursive: true });
		writeFileSync(
			join(skillRoot, "SKILL.md"),
			"---\nname: Safe\u001b[2JName\ndescription: Visible\u001b]0;PWNED\u0007 description\n---\nInstructions.\n",
		);
		const core = createTuiLiveCore({
			projectRoot,
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);
		const lines: string[] = [];
		vi.spyOn(view, "appendText").mockImplementation((value) => {
			lines.push(value);
		});
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 36 });
		try {
			startSkillBrowser(core, view);

			const output = lines.join("\n");
			expect(output).not.toContain("\u001b[2J");
			expect(output).not.toContain("\u001b]0;");
			expect(stripAnsi(output)).toContain("SafeName");
			expect(stripAnsi(output)).toContain("Visible description");
		} finally {
			if (columns) Object.defineProperty(process.stdout, "columns", columns);
			else Reflect.deleteProperty(process.stdout, "columns");
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
