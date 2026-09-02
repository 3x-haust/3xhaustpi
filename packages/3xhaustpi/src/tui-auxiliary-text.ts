import { cellWidth, sanitizeTerminalText, splitGraphemes } from "./tui-text.ts";

export function wrapAuxiliaryText(value: string, columns: number): readonly string[] {
	const sanitized = sanitizeTerminalText(value);
	if (!sanitized) return [];
	return sanitized.split("\n").flatMap((source) => {
		if (!source) return [""];
		const lines: string[] = [];
		let line = "";
		let width = 0;
		for (const grapheme of splitGraphemes(source)) {
			const next = cellWidth(grapheme);
			if (line && width + next > columns) {
				lines.push(line);
				line = "";
				width = 0;
			}
			line += grapheme;
			width += next;
		}
		if (line) lines.push(line);
		return lines;
	});
}
