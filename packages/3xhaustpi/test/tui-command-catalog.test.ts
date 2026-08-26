import { describe, expect, it } from "vitest";
import { TUI_PRIMARY_COMMANDS } from "../src/tui-command-catalog.ts";
import { formatHelpCommandLines } from "../src/tui-command-helpers.ts";
import { stripAnsi } from "../src/tui-text.ts";

const expectedNames = [
	"new",
	"resume",
	"goal",
	"btw",
	"compact",
	"rewind",
	"review",
	"status",
	"model",
	"project",
	"account",
	"skills",
	"settings",
	"help",
	"exit",
] as const;

describe("primary TUI command catalog", () => {
	it("exposes only task-oriented commands in deliberate order", () => {
		expect(TUI_PRIMARY_COMMANDS.map(({ name }) => name)).toEqual(expectedNames);
		expect(new Set(TUI_PRIMARY_COMMANDS.map(({ name }) => name)).size).toBe(TUI_PRIMARY_COMMANDS.length);
	});

	it("drives help from the same canonical usage tokens", () => {
		const help = stripAnsi(formatHelpCommandLines(120).join("\n"));

		for (const command of TUI_PRIMARY_COMMANDS) expect(help).toContain(command.usage);
		for (const hidden of [
			"/sessions",
			"/chats",
			"/chat ",
			"/projects",
			"/provider",
			"/thinking",
			"/recover",
			"/agents",
			"/resources",
			"/skill ",
			"/mcp",
			"/computer",
			"/clear",
			"/history",
		]) {
			expect(help).not.toContain(hidden);
		}
	});
});
