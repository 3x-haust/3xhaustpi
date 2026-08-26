import { describe, expect, it } from "vitest";
import { ProviderAuthPromptOverlay } from "../src/tui-auth-prompt.ts";
import { stripAnsi } from "../src/tui-text.ts";

describe("provider authentication prompt overlay", () => {
	it("masks API keys while returning the original secret", () => {
		const answers: string[] = [];
		const overlay = new ProviderAuthPromptOverlay(
			{ type: "secret", message: "Enter API key" },
			(answer) => answers.push(answer),
			() => {},
		);

		overlay.handleInput("secret-value");
		const rendered = stripAnsi(overlay.render(56).join("\n"));
		overlay.handleInput("\r");

		expect(rendered).toContain("••••••••••••");
		expect(rendered).not.toContain("secret-value");
		expect(answers).toEqual(["secret-value"]);
	});

	it("returns the selected OAuth option and supports cancellation", () => {
		const answers: string[] = [];
		let cancellations = 0;
		const overlay = new ProviderAuthPromptOverlay(
			{
				type: "select",
				message: "Sign in method",
				options: [
					{ id: "browser", label: "Browser OAuth" },
					{ id: "device", label: "Device code" },
				],
			},
			(answer) => answers.push(answer),
			() => {
				cancellations += 1;
			},
		);

		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		expect(answers).toEqual(["device"]);

		const cancelled = new ProviderAuthPromptOverlay(
			{ type: "text", message: "Account name" },
			() => {},
			() => {
				cancellations += 1;
			},
		);
		cancelled.handleInput("\x1b");
		expect(cancellations).toBe(1);
	});
});
