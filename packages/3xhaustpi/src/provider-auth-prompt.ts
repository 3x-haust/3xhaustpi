import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

export interface AuthPromptQuestionOptions {
	readonly secret: boolean;
	readonly signal?: AbortSignal;
}

export interface AuthPromptInput {
	question(prompt: string, options: AuthPromptQuestionOptions): Promise<string>;
}

export interface AuthPromptTerminal {
	readonly input: NodeJS.ReadableStream & {
		readonly isTTY?: boolean;
		setRawMode?(mode: boolean): void;
	};
	readonly output: NodeJS.WritableStream & { readonly isTTY?: boolean };
}

export function createTerminalAuthPromptInput(
	terminal: AuthPromptTerminal = { input: process.stdin, output: process.stdout },
): AuthPromptInput {
	return {
		question(prompt, options) {
			if (options.signal?.aborted) return Promise.reject(new Error("Login cancelled"));
			const hideInput = Boolean(options.secret && terminal.input.isTTY && terminal.input.setRawMode);
			const mutedOutput = hideInput
				? new Writable({
						write(_chunk, _encoding, callback) {
							callback();
						},
					})
				: undefined;
			if (hideInput) terminal.output.write(prompt);
			const readline = createInterface({
				input: terminal.input,
				output: mutedOutput ?? terminal.output,
				...(hideInput ? { terminal: true } : {}),
			});
			return new Promise<string>((resolve, reject) => {
				let settled = false;
				const finish = (answer?: string, error?: Error) => {
					if (settled) return;
					settled = true;
					options.signal?.removeEventListener("abort", abort);
					readline.removeListener("SIGINT", abort);
					readline.removeListener("close", close);
					readline.close();
					if (hideInput) terminal.output.write("\n");
					if (error) reject(error);
					else resolve(answer ?? "");
				};
				const abort = () => finish(undefined, new Error("Login cancelled"));
				const close = () => finish(undefined, new Error("Login cancelled"));
				options.signal?.addEventListener("abort", abort, { once: true });
				readline.once("SIGINT", abort);
				readline.once("close", close);
				readline.question(hideInput ? "" : prompt, (answer) => finish(answer));
			});
		},
	};
}

const terminalAuthPromptInput = createTerminalAuthPromptInput();

export async function answerAuthPrompt(
	prompt: AuthPrompt,
	input: AuthPromptInput = terminalAuthPromptInput,
): Promise<string> {
	if (prompt.type === "select") {
		console.log(`\n${sanitizeTerminalText(prompt.message)}`);
		for (let index = 0; index < prompt.options.length; index += 1) {
			const option = prompt.options[index]!;
			console.log(`  ${index + 1}. ${sanitizeTerminalText(option.label)}`);
		}
		const answer = await input.question(`Enter number (1-${prompt.options.length}): `, {
			secret: false,
			...(prompt.signal ? { signal: prompt.signal } : {}),
		});
		const selected =
			answer.trim() === "" && prompt.options[0]?.label.includes("(default)")
				? prompt.options[0]
				: prompt.options[Number.parseInt(answer, 10) - 1];
		if (!selected) throw new Error("Invalid login selection");
		return selected.id;
	}
	const message = sanitizeTerminalText(prompt.message);
	const placeholder = prompt.placeholder ? ` (${sanitizeTerminalText(prompt.placeholder)})` : "";
	return input.question(`${message}${placeholder}: `, {
		secret: prompt.type === "secret",
		...(prompt.signal ? { signal: prompt.signal } : {}),
	});
}

export function notifyAuth(event: AuthEvent): void {
	if (event.type === "auth_url") {
		console.log(`\nOpen this URL in your browser:\n${sanitizeTerminalText(event.url)}`);
		if (event.instructions) console.log(sanitizeTerminalText(event.instructions));
		if (process.platform === "darwin") spawnSync("open", [event.url], { stdio: "ignore" });
		return;
	}
	if (event.type === "device_code") {
		console.log(`\nOpen this URL in your browser:\n${sanitizeTerminalText(event.verificationUri)}`);
		console.log(`Enter code: ${sanitizeTerminalText(event.userCode)}`);
		if (process.platform === "darwin") spawnSync("open", [event.verificationUri], { stdio: "ignore" });
		return;
	}
	console.log(sanitizeTerminalText(event.message));
}
