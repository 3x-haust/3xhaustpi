import {
	type Component,
	Editor,
	type EditorTheme,
	getCapabilities,
	Image,
	KeybindingsManager,
	type TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { readClipboardText } from "../../coding-agent/src/utils/clipboard.ts";
import { readClipboardImage } from "../../coding-agent/src/utils/clipboard-image.ts";
import { resizeImage } from "../../coding-agent/src/utils/image-resize.ts";
import { composerEditorRowLimit, layoutComposerPreviews, tokenItemAtCursor } from "./tui-composer-preview-layout.ts";
import type { TuiDisplayImage } from "./tui-image-viewer.ts";
import { parseTuiMouseInput } from "./tui-mouse.ts";
import type { TuiRequestImage } from "./tui-operation-types.ts";
import { accent, muted, selection } from "./tui-text.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.clipboard.pasteImage": true;
		"app.image.openAtCursor": true;
	}
}

interface ComposerAttachment extends TuiDisplayImage {
	readonly index: number;
	readonly previews: Map<string, Image>;
}

interface AttachmentRows {
	readonly attachment: ComposerAttachment;
	readonly start: number;
	readonly end: number;
	readonly startColumn: number;
	readonly endColumn: number;
}

type ComposerEditorOptions = NonNullable<ConstructorParameters<typeof Editor>[2]>;

export interface AttachComposerImageInput extends TuiRequestImage {
	readonly filename?: string;
}

const DEFAULT_EDITOR_THEME: EditorTheme = {
	borderColor: muted,
	selectList: {
		selectedPrefix: accent,
		selectedText: selection,
		description: muted,
		scrollInfo: muted,
		noMatch: muted,
	},
};
const COMPOSER_KEYBINDINGS = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.clipboard.pasteImage": {
		defaultKeys: "ctrl+v",
		description: "Paste an image or clipboard text",
	},
	"app.image.openAtCursor": {
		defaultKeys: "ctrl+o",
		description: "Open the image under the cursor",
	},
});

class ComposerEditor extends Editor {
	onPasteImage?: () => void;

	override handleInput(data: string): void {
		if (COMPOSER_KEYBINDINGS.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}
		super.handleInput(data);
	}
}

export class TuiComposer implements Component {
	readonly editor: ComposerEditor;
	onError?: (error: Error) => void;
	onOpenImage?: (image: TuiDisplayImage) => void;
	onRenderRequested?: () => void;
	private attachments: ComposerAttachment[] = [];
	private attachmentRows: readonly AttachmentRows[] = [];
	private renderedRowCount = 0;
	private nextImageIndex = 1;
	private readonly ui: TUI;

	constructor(ui: TUI, theme: EditorTheme = DEFAULT_EDITOR_THEME, options: ComposerEditorOptions = { paddingX: 1 }) {
		this.ui = ui;
		this.editor = new ComposerEditor(ui, theme, options);
		this.editor.onPasteImage = () => {
			void this.pasteClipboard();
		};
	}

	attachImage(input: AttachComposerImageInput): void {
		const index = this.nextImageIndex++;
		const token = `[image${index}]`;
		const filename = input.filename ?? `image${index}`;
		this.attachments.push({
			...input,
			index,
			token,
			filename,
			previews: new Map(),
		});
		const current = this.editor.getText();
		const separator = current.length > 0 && !/\s$/u.test(current) ? " " : "";
		this.editor.setText(`${current}${separator}${token}`);
		this.onRenderRequested?.();
	}

	imagesFor(text: string): readonly TuiRequestImage[] {
		return this.displayImagesFor(text).map(({ data, mimeType }) => ({ data, mimeType }));
	}

	displayImagesFor(text: string): readonly TuiDisplayImage[] {
		return this.attachments
			.filter(({ token }) => text.includes(token))
			.map(({ data, mimeType, token, filename }) => ({ data, mimeType, token, filename }));
	}

	restoreDraft(text: string, images: readonly TuiRequestImage[]): void {
		const indices = [
			...new Set(
				[...text.matchAll(/\[image(\d+)\]/gu)]
					.map((match) => Number.parseInt(match[1] ?? "", 10))
					.filter((index) => Number.isSafeInteger(index) && index > 0),
			),
		].sort((left, right) => left - right);
		this.attachments = images.flatMap((image, position) => {
			const index = indices[position];
			if (index === undefined) return [];
			return [
				{
					...image,
					index,
					token: `[image${index}]`,
					filename: `image${index}`,
					previews: new Map(),
				},
			];
		});
		this.nextImageIndex = Math.max(this.nextImageIndex, ...indices.map((index) => index + 1));
		this.editor.setText(text);
		this.onRenderRequested?.();
	}

	clearAttachments(): void {
		this.attachments = [];
		this.onRenderRequested?.();
	}

	setMaxVisibleLines(requestedRows: number): void {
		this.editor.setMaxVisibleLines(
			composerEditorRowLimit(this.ui.terminal.rows, requestedRows, this.attachments.length > 0),
		);
	}

	render(width: number): string[] {
		const visible = this.attachments.filter(({ token }) => this.editor.getText().includes(token));
		const layout = layoutComposerPreviews(
			this.editor.render(width),
			visible.map((attachment) => ({
				token: attachment.token,
				value: attachment,
				render: (previewWidth, previewHeight, occurrence) =>
					this.renderPreview(attachment, previewWidth, previewHeight, occurrence),
			})),
			width,
			this.ui.terminal.rows,
		);
		this.attachmentRows = layout.regions.map(({ value, startRow, endRow, startColumn, endColumn }) => ({
			attachment: value,
			start: startRow,
			end: endRow,
			startColumn,
			endColumn,
		}));
		this.renderedRowCount = layout.lines.length;
		return [...layout.lines];
	}

	handleMouseInput(data: string): boolean {
		const mouse = parseTuiMouseInput(data);
		if (mouse?.button !== "left" || mouse.kind !== "press") return false;
		const composerTop = this.ui.terminal.rows - 3 - this.renderedRowCount + 1;
		const relativeRow = mouse.row - composerTop;
		const target = this.attachmentRows.find(
			({ start, end, startColumn, endColumn }) =>
				relativeRow >= start && relativeRow <= end && mouse.column >= startColumn && mouse.column <= endColumn,
		);
		if (!target) return false;
		this.onOpenImage?.(target.attachment);
		return true;
	}

	handleInput(data: string): void {
		if (COMPOSER_KEYBINDINGS.matches(data, "app.image.openAtCursor")) {
			const { line, col } = this.editor.getCursor();
			const editorLine = this.editor.getLines()[line];
			const target = editorLine ? tokenItemAtCursor(editorLine, col, this.attachments) : undefined;
			if (target) this.onOpenImage?.(target);
			return;
		}
		this.editor.handleInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
		for (const attachment of this.attachments) {
			for (const preview of attachment.previews.values()) preview.invalidate();
		}
	}

	private renderPreview(
		attachment: ComposerAttachment,
		width: number,
		height: number,
		occurrence: number,
	): readonly string[] {
		if (!getCapabilities().images) return [muted("▧")];
		const key = `${height}:${occurrence}`;
		let preview = attachment.previews.get(key);
		if (!preview) {
			preview = new Image(
				attachment.data,
				attachment.mimeType,
				{ fallbackColor: muted },
				{ maxWidthCells: 18, maxHeightCells: height },
			);
			attachment.previews.set(key, preview);
		}
		return preview.render(width + 2);
	}

	private async pasteClipboard(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				const clipboardText = await readClipboardText();
				if (clipboardText) this.editor.handleInput(`\x1b[200~${clipboardText}\x1b[201~`);
				return;
			}
			const processed = await resizeImage(image.bytes, image.mimeType, {
				maxWidth: 2000,
				maxHeight: 2000,
				maxBytes: 4.5 * 1024 * 1024,
			});
			if (!processed) {
				throw new Error("[Image omitted: could not be resized below the inline image size limit.]");
			}
			if (
				processed.mimeType !== "image/png" &&
				processed.mimeType !== "image/jpeg" &&
				processed.mimeType !== "image/webp"
			) {
				throw new Error(`Unsupported processed image type: ${processed.mimeType}`);
			}
			this.attachImage({
				data: processed.data,
				mimeType: processed.mimeType,
				filename: "clipboard.png",
			});
		} catch (cause) {
			this.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
		}
	}
}
