import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import { frameLine, muted, text } from "./tui-text.ts";
import { fitTranscriptCards } from "./tui-transcript.ts";

export interface TuiHistoryOverlayActions {
	readonly close: () => void;
	readonly invalidate: () => void;
}

export class TuiHistoryOverlay implements Component, Focusable {
	focused = false;
	private offset = 0;
	private maxOffset = 0;
	private readonly entries: readonly string[];
	private readonly rowsProvider: () => number;
	private readonly actions: TuiHistoryOverlayActions;

	constructor(entries: readonly string[], rowsProvider: () => number, actions: TuiHistoryOverlayActions) {
		this.entries = entries;
		this.rowsProvider = rowsProvider;
		this.actions = actions;
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		const bodyRows = Math.max(1, this.rowsProvider() - 2);
		const extended = fitTranscriptCards(this.entries, columns, Number.MAX_SAFE_INTEGER);
		this.maxOffset = Math.max(0, extended.length - bodyRows);
		this.offset = Math.min(this.offset, this.maxOffset);
		const end = Math.max(0, extended.length - this.offset);
		const body = extended.slice(Math.max(0, end - bodyRows), end);
		return [
			frameLine(`${text("HISTORY")}  ${muted("PgUp/PgDn · Home/End · q close")}`, columns),
			...Array.from({ length: Math.max(0, bodyRows - body.length) }, () => ""),
			...body.map((line) => frameLine(line, columns)),
			frameLine(this.offset === 0 ? muted("live tail") : muted(`${this.offset} rows from tail`), columns),
		];
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.rowsProvider() - 3);
		if (data.toLowerCase() === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+t")) {
			this.actions.close();
			return;
		}
		if (matchesKey(data, "pageUp")) this.offset = Math.min(this.maxOffset, this.offset + page);
		else if (matchesKey(data, "pageDown")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "home")) this.offset = this.maxOffset;
		else if (matchesKey(data, "end")) this.offset = 0;
		else if (matchesKey(data, "up")) this.offset = Math.min(this.maxOffset, this.offset + 1);
		else if (matchesKey(data, "down")) this.offset = Math.max(0, this.offset - 1);
		else return;
		this.actions.invalidate();
	}

	invalidate(): void {}
}
