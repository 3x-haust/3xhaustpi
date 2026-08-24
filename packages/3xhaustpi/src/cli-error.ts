import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

export function formatCliError(prefix: string, message: string, stylesEnabled = true): string {
	const value = `${sanitizeTerminalText(prefix)}: ${sanitizeTerminalText(message)}`;
	return stylesEnabled ? `\u001b[38;5;203m${value}\u001b[0m` : value;
}
