import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { notifyAuth } from "../src/provider-auth-prompt.ts";
import { answerAuthPrompt, createTerminalAuthPromptInput } from "../src/provider-runtime.ts";

describe("provider auth prompts", () => {
	it("sanitizes provider-controlled authentication output", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		notifyAuth({
			type: "device_code",
			verificationUri: "https://example.test\u001b]52;c;c2VjcmV0\u0007",
			userCode: "SAFE\u001b[2J",
		});

		const output = log.mock.calls.flat().join("\n");
		expect(output).not.toContain("\u001b]");
		expect(output).not.toContain("\u001b[");
		expect(output).not.toContain("c2VjcmV0");
		expect(output).toContain("SAFE");
	});

	it("marks only secret prompts as non-echoing while preserving text and select answers", async () => {
		const question = vi
			.fn()
			.mockResolvedValueOnce("plain value")
			.mockResolvedValueOnce("secret value")
			.mockResolvedValueOnce("2");
		const input = { question };
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(answerAuthPrompt({ type: "text", message: "Name" }, input)).resolves.toBe("plain value");
		await expect(answerAuthPrompt({ type: "secret", message: "API key" }, input)).resolves.toBe("secret value");
		await expect(
			answerAuthPrompt(
				{
					type: "select",
					message: "Method",
					options: [
						{ id: "browser", label: "Browser" },
						{ id: "device", label: "Device" },
					],
				},
				input,
			),
		).resolves.toBe("device");

		expect(question.mock.calls).toEqual([
			["Name: ", { secret: false }],
			["API key: ", { secret: true }],
			["Enter number (1-2): ", { secret: false }],
		]);
		expect(log).toHaveBeenCalledWith("\nMethod");
		expect(log).toHaveBeenCalledWith("  1. Browser");
		expect(log).toHaveBeenCalledWith("  2. Device");
		log.mockRestore();
	});

	it("uses terminal raw mode and never writes a secret value to the PTY output", async () => {
		const input = new PassThrough() as PassThrough & {
			isTTY: boolean;
			setRawMode(mode: boolean): void;
		};
		const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
		input.isTTY = true;
		input.setRawMode = vi.fn();
		output.isTTY = true;
		output.columns = 80;
		let written = "";
		output.on("data", (chunk) => {
			written += chunk.toString();
		});
		const terminal = createTerminalAuthPromptInput({ input, output });

		const pending = terminal.question("API key: ", { secret: true });
		input.write("not-for-the-screen\n");

		await expect(pending).resolves.toBe("not-for-the-screen");
		expect(input.setRawMode).toHaveBeenCalledWith(true);
		expect(input.setRawMode).toHaveBeenLastCalledWith(false);
		expect(written).toContain("API key: ");
		expect(written).not.toContain("not-for-the-screen");
	});

	it("uses input raw mode for secrets when terminal output is redirected", async () => {
		const input = new PassThrough() as PassThrough & {
			isTTY: boolean;
			setRawMode(mode: boolean): void;
		};
		const output = new PassThrough() as PassThrough & { isTTY: boolean };
		input.isTTY = true;
		input.setRawMode = vi.fn();
		output.isTTY = false;
		const terminal = createTerminalAuthPromptInput({ input, output });

		const pending = terminal.question("API key: ", { secret: true });
		input.write("redirected-secret\n");

		await expect(pending).resolves.toBe("redirected-secret");
		expect(input.setRawMode).toHaveBeenCalledWith(true);
		expect(input.setRawMode).toHaveBeenLastCalledWith(false);
	});
});
