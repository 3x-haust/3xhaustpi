import { homedir } from "node:os";
import { basename } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { PRODUCT_DISPLAY_NAME, PRODUCT_MACHINE_NAME } from "./product-identity.ts";
import { formatTuiActivityLine } from "./tui-activity-state.ts";
import type { TuiDensityMode, TuiLayoutContract, TuiViewState } from "./tui-contract.ts";
import {
	accent,
	cellWidth,
	dim,
	ellipsizeCells,
	frameLine,
	muted,
	sanitizeTerminalText,
	stripAnsi,
	text,
} from "./tui-text.ts";
import { fitTranscriptCards } from "./tui-transcript.ts";

function densityMode(columns: number): TuiDensityMode {
	if (columns < 40) return "degraded";
	if (columns < 56) return "minimal";
	if (columns < 80) return "compact";
	if (columns < 120) return "full";
	return "wide";
}

export function terminalBelowFloor(columns: number, rows: number): boolean {
	return columns < 20 || rows < 8;
}

export function terminalFloorLines(columns: number, rows: number): readonly string[] {
	const width = Math.max(1, Math.floor(columns));
	const height = Math.max(1, Math.floor(rows));
	const warning = width >= 28 ? "3xhaustPi · terminal too small" : width >= 19 ? "3xhaustPi too small" : "3xhaustPi";
	return [warning, "/exit"].slice(0, height).map((line) => frameLine(line, width));
}

export function layoutTuiFrame(
	columns: number,
	rows: number,
	options: { readonly autocompleteRows?: number } = {},
): TuiLayoutContract {
	const width = Math.max(1, Math.floor(columns));
	const height = Math.max(1, Math.floor(rows));
	const requested = Math.max(0, Math.floor(options.autocompleteRows ?? 0));
	const bounded = Math.min(requested, Math.floor(height * 0.4));
	const chromeRows = 6;
	const autocompleteRows = Math.min(bounded, Math.max(0, height - chromeRows - 1));
	const transcriptRows = Math.max(1, height - chromeRows - autocompleteRows);
	return {
		columns: width,
		rows: height,
		mode: densityMode(width),
		identityRows: 2,
		contextRows: 0,
		activityRows: 1,
		composerRows: 3,
		footerRows: 0,
		autocompleteRows,
		chromeRows,
		transcriptRows,
		totalRows: chromeRows + transcriptRows + autocompleteRows,
	};
}

function compactTokens(value: number): string {
	if (value < 1_000) return String(value);
	const thousands = value / 1_000;
	return `${thousands >= 100 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
}

function compactPath(value: string): string {
	const home = homedir();
	return sanitizeTerminalText(value.startsWith(home) ? `~${value.slice(home.length)}` : value);
}

export function contextHeaderRail(state: TuiViewState, layout: TuiLayoutContract): string {
	const thinking = state.thinkingLevel ? `:${state.thinkingLevel}` : "";
	if (layout.mode === "degraded" || layout.mode === "minimal")
		return frameLine(`${text(sanitizeTerminalText(state.model))}${thinking ? dim(thinking) : ""}`, layout.columns);
	const right = `${dim(`(${sanitizeTerminalText(state.provider)})`)} ${text(sanitizeTerminalText(state.model))}${dim(thinking)}`;
	const path = compactPath(state.projectRoot);
	const pathBudget = Math.max(1, layout.columns - cellWidth(stripAnsi(right)) - 2);
	const compactedPath =
		cellWidth(path) <= pathBudget
			? path
			: `…/${ellipsizeCells(sanitizeTerminalText(basename(state.projectRoot)), Math.max(1, pathBudget - 2))}`;
	const left: string[] = [muted(compactedPath)];
	const used = state.contextTokens;
	const limit = state.contextLimit ?? 0;
	if (used !== undefined && limit > 0)
		left.push(text(`${compactTokens(used)}/${compactTokens(limit)} (${((used / limit) * 100).toFixed(1)}%)`));
	else if (limit > 0) left.push(muted(`0/${compactTokens(limit)} (0.0%)`));
	let body = "";
	for (const extra of [left.slice(1), []]) {
		body = [left[0], ...extra].join(`  ${dim("•")} `);
		if (cellWidth(stripAnsi(body)) + cellWidth(stripAnsi(right)) + 2 <= layout.columns) break;
	}
	const gap = Math.max(2, layout.columns - cellWidth(stripAnsi(body)) - cellWidth(stripAnsi(right)));
	return frameLine(`${body}${" ".repeat(gap)}${right}`, layout.columns);
}

export function identityRail(state: TuiViewState, layout: TuiLayoutContract): string {
	if (layout.mode === "degraded" || layout.mode === "minimal")
		return frameLine(text(PRODUCT_DISPLAY_NAME), layout.columns);
	const project = sanitizeTerminalText(basename(state.projectRoot));
	const parts = [`(${accent("😺")} ${text(`${PRODUCT_DISPLAY_NAME} Native`)})`];
	if (project !== PRODUCT_MACHINE_NAME) parts.push(dim(project));
	return frameLine(parts.join(" "), layout.columns);
}

function composerRail(state: TuiViewState, layout: TuiLayoutContract): readonly string[] {
	const rule = accent("─".repeat(layout.columns));
	return [rule, frameLine(`${accent(">")} ${state.input}`, layout.columns), rule];
}

export function transcriptViewportRows(
	rows: number,
	reservedRows = 0,
	columns = process.stdout.columns || 120,
): number {
	return layoutTuiFrame(columns, rows, { autocompleteRows: reservedRows }).transcriptRows;
}

export const TUI_SCROLL_KEYS = {
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
	altUp: "\u001b[1;3A",
	altDown: "\u001b[1;3B",
	altEnd: "\u001b[1;3F",
} as const;

export function isTuiTranscriptScrollInput(data: string, composerText: string): boolean {
	return composerText.length === 0 && Object.values(TUI_SCROLL_KEYS).some((key) => key === data);
}

export class TranscriptViewport implements Component {
	private readonly entries: readonly string[];
	private readonly rowsProvider: () => number;
	private readonly reservedRowsProvider: () => number;
	private readonly offsetProvider: () => number;

	constructor(
		entries: readonly string[],
		rowsProvider: () => number = () => process.stdout.rows || 36,
		reservedRowsProvider: () => number = () => 0,
		offsetProvider: () => number = () => 0,
	) {
		this.entries = entries;
		this.rowsProvider = rowsProvider;
		this.reservedRowsProvider = reservedRowsProvider;
		this.offsetProvider = offsetProvider;
	}
	render(width: number): string[] {
		const columns = Math.max(1, width);
		const budget = transcriptViewportRows(this.rowsProvider(), this.reservedRowsProvider(), columns);
		const offset = Math.max(0, Math.floor(this.offsetProvider()));
		let visibleLines: string[];
		if (offset === 0) visibleLines = fitTranscriptCards(this.entries, columns, budget);
		else {
			const extended = fitTranscriptCards(this.entries, columns, budget + offset);
			const end = Math.max(0, extended.length - offset);
			visibleLines = extended.slice(Math.max(0, end - budget), end);
		}
		return [...Array.from({ length: Math.max(0, budget - visibleLines.length) }, () => ""), ...visibleLines].map(
			(line) => frameLine(line, columns),
		);
	}
	invalidate(): void {}
}

export function renderTuiFrame(
	state: TuiViewState,
	columns = 120,
	rows = 36,
	options: { readonly autocompleteRows?: number } = {},
): string {
	if (terminalBelowFloor(columns, rows)) return terminalFloorLines(columns, rows).join("\n");
	const layout = layoutTuiFrame(columns, rows, options);
	const activity = frameLine(
		formatTuiActivityLine({
			status: state.status,
			queuedCount: state.queuedRequests.length,
			activeCount: state.activeTasks ?? 0,
			resumable: state.workspace.chats.some(
				(chat) => chat.status === "running" || chat.status === "paused" || chat.status === "queued",
			),
		}),
		layout.columns,
	);
	const visible = fitTranscriptCards(state.messages, layout.columns, layout.transcriptRows);
	const transcript = [
		...Array.from({ length: Math.max(0, layout.transcriptRows - visible.length) }, () => ""),
		...visible,
	];
	return [
		...transcript,
		...Array.from({ length: layout.autocompleteRows }, () => ""),
		activity,
		...composerRail(state, layout),
		contextHeaderRail(state, layout),
		identityRail(state, layout),
	]
		.slice(0, layout.rows)
		.map((line) => frameLine(line, layout.columns))
		.join("\n");
}
