import {
	type Component,
	type Focusable,
	Image,
	matchesKey,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import { parseTuiMouseInput } from "./tui-mouse.ts";
import type { TuiRequestImage } from "./tui-operation-types.ts";
import { accent, cellWidth, ellipsizeCells, muted, sanitizeTerminalText } from "./tui-text.ts";

const IMAGE_OVERLAY_HEIGHT_RATIO = 0.9;
const IMAGE_OVERLAY_CHROME_ROWS = 2;

export interface TuiDisplayImage extends TuiRequestImage {
	readonly token: string;
	readonly filename: string;
}

export function expandedImagePreviewRows(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows * IMAGE_OVERLAY_HEIGHT_RATIO) - IMAGE_OVERLAY_CHROME_ROWS);
}

export function formatImagePreviewLabel(prefix: string, format: string, filename: string, width: number): string {
	const columns = Math.max(1, width);
	const action = "click to enlarge";
	const suffix = ` · ${action}`;
	if (columns <= cellWidth(suffix)) return ellipsizeCells(action, columns);
	const metadata = sanitizeTerminalText(`${prefix} · ${format} · ${filename}`);
	return `${ellipsizeCells(metadata, columns - cellWidth(suffix))}${suffix}`;
}

class TuiImageOverlay implements Component, Focusable {
	focused = false;
	private readonly preview: Image;
	private readonly image: TuiDisplayImage;
	private readonly close: () => void;

	constructor(image: TuiDisplayImage, rows: number, close: () => void) {
		this.image = image;
		this.close = close;
		this.preview = new Image(
			image.data,
			image.mimeType,
			{ fallbackColor: muted },
			{
				filename: image.filename,
				maxWidthCells: Number.MAX_SAFE_INTEGER,
				maxHeightCells: expandedImagePreviewRows(rows),
			},
		);
	}

	render(width: number): string[] {
		const format = this.image.mimeType.slice("image/".length).toUpperCase();
		const title = sanitizeTerminalText(`${this.image.token} · ${format} · ${this.image.filename}`);
		return [
			accent(ellipsizeCells(title, Math.max(1, width))),
			...this.preview.render(width),
			muted("click or Esc to close"),
		];
	}

	handleInput(data: string): void {
		const mouse = parseTuiMouseInput(data);
		if (
			(mouse?.button === "left" && mouse.kind === "press") ||
			matchesKey(data, "escape") ||
			matchesKey(data, "enter")
		) {
			this.close();
		}
	}

	invalidate(): void {
		this.preview.invalidate();
	}
}

export class TuiImageViewer {
	private readonly ui: TUI;
	private handle: OverlayHandle | undefined;

	constructor(ui: TUI) {
		this.ui = ui;
	}

	isOpen(): boolean {
		return this.handle !== undefined;
	}

	open(image: TuiDisplayImage): void {
		this.close();
		const overlay = new TuiImageOverlay(image, this.ui.terminal.rows, () => this.close());
		this.handle = this.ui.showOverlay(overlay, {
			width: "90%",
			maxHeight: "90%",
			anchor: "center",
			margin: 1,
		});
	}

	close(): void {
		this.handle?.hide();
		this.handle = undefined;
	}
}
