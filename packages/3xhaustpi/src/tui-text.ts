import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

const ESC = "\u001b[";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export { sanitizeTerminalText } from "./terminal-sanitizer.ts";

export function splitGraphemes(value: string): readonly string[] {
	return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

export function terminalStylesEnabled(): boolean {
	return process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

const tone = (code: number, value: string) => (terminalStylesEnabled() ? `${ESC}38;5;${code}m${value}${ESC}0m` : value);
const style = (code: string, value: string) => (terminalStylesEnabled() ? `${ESC}${code}m${value}${ESC}0m` : value);

export const accent = (value: string) => tone(111, value);
export const text = (value: string) => tone(255, value);
export const muted = (value: string) => tone(245, value);
export const dim = (value: string) => tone(239, value);
export const success = (value: string) => tone(114, value);
export const warning = (value: string) => tone(214, value);
export const failure = (value: string) => tone(203, value);
export const italic = (value: string) => style("3", value);
export const emphasis = (value: string) => style("1;3", value);
export const selection = (value: string) => (process.env.TERM === "dumb" ? value : `${ESC}7m${value}${ESC}0m`);

export function grayscaleShimmer(value: string, frame: number): string {
	if (!terminalStylesEnabled()) return value;
	const characters = splitGraphemes(value);
	const visibleIndices = characters.flatMap((character, index) => (character.trim() ? [index] : []));
	const highlight =
		visibleIndices[((Math.floor(frame) % visibleIndices.length) + visibleIndices.length) % visibleIndices.length];
	return characters.map((character, index) => tone(index === highlight ? 255 : 242, character)).join("");
}

function readAnsiSequence(value: string): string | undefined {
	if (!value.startsWith(ESC)) return undefined;
	const marker = value.indexOf("m", ESC.length);
	if (marker === -1) return undefined;
	const parameters = value.slice(ESC.length, marker);
	return [...parameters].every((character) => (character >= "0" && character <= "9") || character === ";")
		? value.slice(0, marker + 1)
		: undefined;
}

export function stripAnsi(value: string): string {
	let output = "";
	let index = 0;
	while (index < value.length) {
		const sequence = readAnsiSequence(value.slice(index));
		if (sequence) {
			index += sequence.length;
			continue;
		}
		const character = Array.from(value.slice(index))[0];
		if (!character) break;
		output += character;
		index += character.length;
	}
	return output;
}

export function cellWidth(value: string): number {
	return visibleWidth(value);
}

function clipAnsi(value: string, columns: number): string {
	if (columns <= 0) return "";
	const output = sliceByColumn(value, 0, columns, true);
	return value.includes(ESC) && !output.endsWith(`${ESC}0m`) ? `${output}${ESC}0m` : output;
}

export function ellipsizeCells(value: string, columns: number): string {
	if (cellWidth(stripAnsi(value)) <= columns) return value;
	if (columns <= 1) return clipAnsi(value, columns);
	return `${clipAnsi(value, columns - 1)}…`;
}

export function frameLine(value: string, columns: number): string {
	return clipAnsi(value, columns);
}

export function promptSurfaceLine(value: string, columns: number): string {
	const width = Math.max(1, columns);
	const clipped = clipAnsi(value, width);
	const padding = " ".repeat(Math.max(0, width - cellWidth(stripAnsi(clipped))));
	if (!terminalStylesEnabled()) return `${clipped}${padding}`;
	return `${ESC}48;5;238m${ESC}38;5;255m${clipped}${padding}${ESC}0m`;
}
