import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import {
	accent,
	cellWidth,
	failure,
	frameLine,
	muted,
	sanitizeTerminalText,
	splitGraphemes,
	success,
	text,
} from "./tui-text.ts";

export type ReadonlyOutputOverlayState = "running" | "complete" | "failure";

export interface ReadonlyOutputOverlayActions {
	readonly close: () => void;
	readonly invalidate: () => void;
	readonly cancel?: () => void;
}

function wrapText(value: string, columns: number): readonly string[] {
	const sanitized = sanitizeTerminalText(value);
	if (!sanitized) return [];
	const width = Math.max(1, Math.floor(columns));
	return sanitized.split("\n").flatMap((source) => {
		if (!source) return [""];
		const lines: string[] = [];
		let line = "";
		let lineWidth = 0;
		for (const grapheme of splitGraphemes(source)) {
			const graphemeWidth = cellWidth(grapheme);
			if (line && lineWidth + graphemeWidth > width) {
				lines.push(line);
				line = "";
				lineWidth = 0;
			}
			line += grapheme;
			lineWidth += graphemeWidth;
		}
		if (line) lines.push(line);
		return lines;
	});
}

export class ReadonlyOutputOverlay implements Component, Focusable {
	focused = false;
	private readonly title: string;
	private readonly rowsProvider: () => number;
	private readonly actions: ReadonlyOutputOverlayActions;
	private output = "";
	private state: ReadonlyOutputOverlayState = "running";
	private offset = 0;
	private maxOffset = 0;
	private bodyRows = 1;
	private following = true;

	constructor(title: string, rowsProvider: () => number, actions: ReadonlyOutputOverlayActions) {
		this.title = sanitizeTerminalText(title).replace(/\n/gu, " ");
		this.rowsProvider = rowsProvider;
		this.actions = actions;
	}

	setText(value: string): void {
		this.output = value;
		this.actions.invalidate();
	}

	appendText(value: string): void {
		this.output += value;
		this.actions.invalidate();
	}

	setState(state: ReadonlyOutputOverlayState): void {
		if (state === this.state) return;
		this.state = state;
		this.actions.invalidate();
	}

	render(width: number): string[] {
		const columns = Math.max(1, Math.floor(width));
		const terminalRows = Math.max(1, Math.floor(this.rowsProvider()));
		const maxRows = Math.max(1, Math.floor(terminalRows * 0.4));
		const title = frameLine(`${accent(this.title)} · ${this.stateLabel()}`, columns);
		if (maxRows === 1) return [title];

		const body = wrapText(this.output, columns);
		this.bodyRows = Math.max(0, maxRows - 3);
		this.maxOffset = Math.max(0, body.length - this.bodyRows);
		this.offset = this.following ? this.maxOffset : Math.min(this.offset, this.maxOffset);
		const visible = body.slice(this.offset, this.offset + this.bodyRows);
		const current = Math.min(body.length, this.offset + visible.length);
		const footer = frameLine(muted(`${current}/${body.length} rows${this.following ? " · live" : ""}`), columns);
		if (maxRows === 2) return [title, footer];
		const hint =
			this.state === "running" ? "↑↓/PgUp/PgDn · Home/End · Esc cancel" : "↑↓/PgUp/PgDn · Home/End · Esc/q close";
		return [
			title,
			frameLine(muted(hint), columns),
			...visible.map((line) => frameLine(line ? text(line) : "", columns)),
			footer,
		].slice(0, maxRows);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.state === "running") this.actions.cancel?.();
			this.actions.close();
			return;
		}
		if (matchesKey(data, "q")) {
			if (this.state !== "running") this.actions.close();
			return;
		}
		if (matchesKey(data, "home")) {
			this.offset = 0;
			this.following = this.maxOffset === 0;
		} else if (matchesKey(data, "end")) {
			this.offset = this.maxOffset;
			this.following = true;
		} else {
			const delta = matchesKey(data, "up")
				? -1
				: matchesKey(data, "down")
					? 1
					: matchesKey(data, "pageUp")
						? -Math.max(1, this.bodyRows)
						: matchesKey(data, "pageDown")
							? Math.max(1, this.bodyRows)
							: 0;
			if (!delta) return;
			this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
			this.following = this.offset === this.maxOffset;
		}
		this.actions.invalidate();
	}

	invalidate(): void {}

	private stateLabel(): string {
		if (this.state === "complete") return success("✓ complete");
		if (this.state === "failure") return failure("× failure");
		return text("• running");
	}
}
