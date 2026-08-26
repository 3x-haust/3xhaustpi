import {
	type Component,
	type Focusable,
	type SelectItem,
	SelectList,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { AgentConversationRewindPoint } from "./agent-session-catalog.ts";
import { accent, frameLine, muted, sanitizeTerminalText, selection } from "./tui-text.ts";

const THEME: SelectListTheme = {
	selectedPrefix: accent,
	selectedText: selection,
	description: muted,
	scrollInfo: muted,
	noMatch: muted,
};

export interface RewindOverlayActions {
	readonly select: (point: AgentConversationRewindPoint) => void;
	readonly close: () => void;
}

export class RewindOverlay implements Component, Focusable {
	focused = false;
	private readonly points: readonly AgentConversationRewindPoint[];
	private readonly rowsProvider: () => number;
	private readonly list: SelectList;

	constructor(
		points: readonly AgentConversationRewindPoint[],
		rowsProvider: () => number,
		actions: RewindOverlayActions,
	) {
		this.points = points;
		this.rowsProvider = rowsProvider;
		const items: SelectItem[] = points.map((point) => ({
			value: point.entryId,
			label: `Turn ${point.turn} · ${sanitizeTerminalText(point.prompt)}`,
			description: "branch before this prompt",
		}));
		this.list = new SelectList(items, 8, THEME);
		this.list.onSelect = (item) => {
			const point = this.points.find(({ entryId }) => entryId === item.value);
			if (point) actions.select(point);
		};
		this.list.onCancel = actions.close;
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		const rows = Math.max(3, Math.floor(this.rowsProvider()));
		const hint =
			columns < 48
				? "Conversation only · original kept"
				: "Original preserved · conversation only · Enter branch · Esc close";
		this.list.setMaxVisible(Math.max(1, rows - 3));
		return [
			frameLine(accent("Rewind conversation"), columns),
			frameLine(muted(hint), columns),
			...this.list.render(columns),
		].slice(0, rows);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
