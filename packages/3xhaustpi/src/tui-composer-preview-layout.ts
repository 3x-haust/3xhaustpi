import { cellWidth, stripAnsi } from "./tui-text.ts";

const MAX_PREVIEW_COLUMNS = 18;
const MAX_PREVIEW_ROWS = 4;
const BASE_COMPOSER_ROWS = 2;
const FIXED_CHROME_AND_TRANSCRIPT_ROWS = 7;

function composerExtraRowReservation(terminalRows: number): number {
	const rows = Math.max(1, Math.floor(terminalRows));
	return Math.max(0, Math.min(Math.floor(rows * 0.4), rows - FIXED_CHROME_AND_TRANSCRIPT_ROWS));
}

export interface ComposerPreviewItem<T> {
	readonly token: string;
	readonly value: T;
	readonly render: (width: number, height: number, occurrence: number) => readonly string[];
}

export interface ComposerPreviewRegion<T> {
	readonly value: T;
	readonly startRow: number;
	readonly endRow: number;
	readonly startColumn: number;
	readonly endColumn: number;
}

export interface ComposerPreviewLayout<T> {
	readonly lines: readonly string[];
	readonly regions: readonly ComposerPreviewRegion<T>[];
}

export function tokenItemAtCursor<T extends { readonly token: string }>(
	line: string,
	column: number,
	items: readonly T[],
): T | undefined {
	for (const item of items) {
		let start = line.indexOf(item.token);
		while (start >= 0) {
			if (column >= start && column < start + item.token.length) return item;
			start = line.indexOf(item.token, start + item.token.length);
		}
	}
	return undefined;
}

interface PositionedPreview<T> extends ComposerPreviewItem<T> {
	readonly column: number;
	readonly occurrence: number;
}

function renderedPreviewWidth(lines: readonly string[], allocatedWidth: number): number {
	for (const line of lines) {
		const kittyParams = line.match(/\u001b_G([^;]*);/u)?.[1];
		const kittyWidth = kittyParams?.match(/(?:^|,)c=(\d+)(?:,|$)/u)?.[1];
		if (kittyWidth) return Math.max(1, Math.min(allocatedWidth, Number.parseInt(kittyWidth, 10)));
		const itermParams = line.match(/\u001b\]1337;File=([^:]*):/u)?.[1];
		const itermWidth = itermParams?.match(/(?:^|;)width=(\d+)(?:;|$)/u)?.[1];
		if (itermWidth) return Math.max(1, Math.min(allocatedWidth, Number.parseInt(itermWidth, 10)));
	}
	const visibleWidth = Math.max(0, ...lines.map((line) => cellWidth(stripAnsi(line))));
	return Math.max(1, Math.min(allocatedWidth, visibleWidth));
}

export function composerPreviewRowBudget(terminalRows: number, editorRows: number): number {
	const reservation = composerExtraRowReservation(terminalRows);
	return Math.max(0, reservation - Math.max(0, editorRows - BASE_COMPOSER_ROWS));
}

export function composerEditorRowLimit(terminalRows: number, requestedRows: number, hasPreviews: boolean): number {
	const requested = Math.max(1, Math.floor(requestedRows));
	if (!hasPreviews) return requested;
	return Math.max(1, Math.min(requested, Math.floor((composerExtraRowReservation(terminalRows) + 1) / 2)));
}

export function layoutComposerPreviews<T>(
	editorLines: readonly string[],
	items: readonly ComposerPreviewItem<T>[],
	width: number,
	terminalRows: number,
): ComposerPreviewLayout<T> {
	const columns = Math.max(1, Math.floor(width));
	const occurrenceCounts = new Map<ComposerPreviewItem<T>, number>();
	const groups = editorLines.map((line) => {
		const plainLine = stripAnsi(line);
		const positioned = items
			.flatMap((item): PositionedPreview<T>[] => {
				const matches: PositionedPreview<T>[] = [];
				let tokenOffset = plainLine.indexOf(item.token);
				while (tokenOffset >= 0) {
					const occurrence = occurrenceCounts.get(item) ?? 0;
					occurrenceCounts.set(item, occurrence + 1);
					matches.push({
						...item,
						column: cellWidth(plainLine.slice(0, tokenOffset)),
						occurrence,
					});
					tokenOffset = plainLine.indexOf(item.token, tokenOffset + item.token.length);
				}
				return matches;
			})
			.sort((left, right) => left.column - right.column);
		return positioned;
	});
	const visibleGroups = groups.filter((group) => group.length > 0);
	const rowBudget = composerPreviewRowBudget(terminalRows, editorLines.length);
	const baseRows = visibleGroups.length > 0 ? Math.floor(rowBudget / visibleGroups.length) : 0;
	let remainingRows = visibleGroups.length > 0 ? rowBudget % visibleGroups.length : 0;
	const output: string[] = [];
	const regions: ComposerPreviewRegion<T>[] = [];

	for (const [lineIndex, editorLine] of editorLines.entries()) {
		const group = groups[lineIndex] ?? [];
		if (group.length > 0) {
			const height = Math.min(MAX_PREVIEW_ROWS, baseRows + (remainingRows-- > 0 ? 1 : 0));
			const previews = group.map((item, index) => {
				const nextColumn = group[index + 1]?.column ?? columns;
				const previewWidth = Math.max(
					1,
					Math.min(MAX_PREVIEW_COLUMNS, nextColumn - item.column, columns - item.column),
				);
				return {
					...item,
					previewWidth,
					lines: height > 0 ? item.render(previewWidth, height, item.occurrence) : [],
				};
			});
			const previewRows = Math.max(0, ...previews.map(({ lines }) => lines.length));
			const groupStart = output.length;
			for (let row = 0; row < previewRows; row++) {
				let line = "";
				for (const preview of previews) {
					const previewLine = preview.lines[row - (previewRows - preview.lines.length)] ?? "";
					const currentColumn = cellWidth(stripAnsi(line));
					line += " ".repeat(Math.max(0, preview.column - currentColumn)) + previewLine;
				}
				output.push(line);
			}
			for (const preview of previews) {
				if (preview.lines.length === 0) continue;
				regions.push({
					value: preview.value,
					startRow: groupStart + previewRows - preview.lines.length,
					endRow: groupStart + previewRows - 1,
					startColumn: preview.column + 1,
					endColumn: preview.column + renderedPreviewWidth(preview.lines, preview.previewWidth),
				});
			}
		}
		output.push(editorLine);
	}
	return { lines: output, regions };
}
