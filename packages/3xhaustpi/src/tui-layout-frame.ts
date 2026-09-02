import { homedir } from "node:os";
import { basename } from "node:path";
import { type Component, Image } from "@earendil-works/pi-tui";
import { PRODUCT_DISPLAY_NAME, PRODUCT_MACHINE_NAME } from "./product-identity.ts";
import { formatTuiActivityLine } from "./tui-activity-state.ts";
import { contextUsageLabel } from "./tui-context-meter.ts";
import type { TuiLayoutContract, TuiViewState } from "./tui-contract.ts";
import { formatImagePreviewLabel, type TuiDisplayImage } from "./tui-image-viewer.ts";
import { layoutTuiFrame, terminalBelowFloor, terminalFloorLines } from "./tui-layout-contract.ts";
import { parseTuiMouseInput } from "./tui-mouse.ts";
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

export { layoutTuiFrame, terminalBelowFloor, terminalFloorLines } from "./tui-layout-contract.ts";

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
	const body = muted(compactedPath);
	const gap = Math.max(2, layout.columns - cellWidth(stripAnsi(body)) - cellWidth(stripAnsi(right)));
	return frameLine(`${body}${" ".repeat(gap)}${right}`, layout.columns);
}

export function identityRail(state: TuiViewState, layout: TuiLayoutContract): string {
	if (layout.columns < 40) return frameLine(text(PRODUCT_DISPLAY_NAME), layout.columns);
	const project = sanitizeTerminalText(basename(state.projectRoot));
	const fallback = project === PRODUCT_MACHINE_NAME ? "" : dim(project);
	const goal = state.goal
		? `${dim("Goal")} ${text(sanitizeTerminalText(state.goal).replace(/\s+/gu, " ").trim())}`
		: fallback;
	const context = contextUsageLabel(state.contextTokens, state.contextLimit, "meter");
	if (!context) return frameLine(goal, layout.columns);
	const right = muted(context);
	const leftBudget = Math.max(1, layout.columns - cellWidth(stripAnsi(right)) - 2);
	const left = ellipsizeCells(goal, leftBudget);
	const gap = Math.max(2, layout.columns - cellWidth(stripAnsi(left)) - cellWidth(stripAnsi(right)));
	return frameLine(`${left}${" ".repeat(gap)}${right}`, layout.columns);
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
	onOpenImage?: (image: TuiDisplayImage) => void;
	private readonly entries: readonly string[];
	private readonly rowsProvider: () => number;
	private readonly reservedRowsProvider: () => number;
	private readonly offsetProvider: () => number;
	private readonly images = new Map<number, TranscriptImage[]>();
	private readonly imageRows = new Map<number, number[]>();
	private nextImageId = 1;

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

	attachImages(entryIndex: number, images: readonly TuiDisplayImage[]): void {
		if (images.length === 0) return;
		this.images.set(
			entryIndex,
			images.map((image) => ({
				id: this.nextImageId++,
				image,
				preview: new Image(
					image.data,
					image.mimeType,
					{ fallbackColor: muted },
					{ filename: image.filename, maxWidthCells: 18, maxHeightCells: 4 },
				),
			})),
		);
	}

	clearImages(): void {
		this.images.clear();
		this.imageRows.clear();
	}

	handleMouseInput(data: string): boolean {
		const mouse = parseTuiMouseInput(data);
		if (mouse?.button !== "left" || mouse.kind !== "press") return false;
		const target = [...this.imageRows].find(([, rows]) => rows.includes(mouse.row));
		if (!target) return false;
		const images = [...this.images.values()].flat();
		const attachment = images.find(({ id }) => id === target[0]);
		if (!attachment) return false;
		this.onOpenImage?.(attachment.image);
		return true;
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		const budget = transcriptViewportRows(this.rowsProvider(), this.reservedRowsProvider(), columns);
		const offset = Math.max(0, Math.floor(this.offsetProvider()));
		const imageRowsByEntry = new Map<number, readonly string[]>();
		for (const [entryIndex, images] of this.images) {
			imageRowsByEntry.set(
				entryIndex,
				images.flatMap(({ id, image, preview }) => {
					const format = image.mimeType.slice("image/".length).toUpperCase();
					const label = formatImagePreviewLabel(image.token, format, image.filename, columns - 2);
					const marker = transcriptImageMarker(id);
					return [muted(label), ...preview.render(Math.max(1, columns - 2))].map((line) => `${marker}  ${line}`);
				}),
			);
		}
		let visibleLines: string[];
		if (offset === 0) visibleLines = fitTranscriptCards(this.entries, columns, budget, imageRowsByEntry);
		else {
			const extended = fitTranscriptCards(this.entries, columns, budget + offset, imageRowsByEntry);
			const end = Math.max(0, extended.length - offset);
			visibleLines = extended.slice(Math.max(0, end - budget), end);
		}
		this.imageRows.clear();
		const padded = [...Array.from({ length: Math.max(0, budget - visibleLines.length) }, () => ""), ...visibleLines];
		return padded.map((line, index) => {
			const ids = [...line.matchAll(TRANSCRIPT_IMAGE_MARKER_PATTERN)].map((match) =>
				Number.parseInt(match[1] ?? "", 10),
			);
			for (const id of ids) {
				const rows = this.imageRows.get(id) ?? [];
				rows.push(index + 1);
				this.imageRows.set(id, rows);
			}
			return frameLine(line.replace(TRANSCRIPT_IMAGE_MARKER_PATTERN, ""), columns);
		});
	}

	invalidate(): void {
		for (const images of this.images.values()) {
			for (const { preview } of images) preview.invalidate();
		}
	}
}

interface TranscriptImage {
	readonly id: number;
	readonly image: TuiDisplayImage;
	readonly preview: Image;
}

const TRANSCRIPT_IMAGE_MARKER_PATTERN = /\u0000image:(\d+)\u0000/gu;

function transcriptImageMarker(id: number): string {
	return `\u0000image:${id}\u0000`;
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
