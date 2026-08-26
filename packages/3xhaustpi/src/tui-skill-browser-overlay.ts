import {
	type Component,
	type Focusable,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { SkillResource } from "./resource-loader.ts";
import {
	accent,
	cellWidth,
	ellipsizeCells,
	frameLine,
	muted,
	sanitizeTerminalText,
	selection,
	splitGraphemes,
	text,
} from "./tui-text.ts";

const SKILL_SELECT_THEME: SelectListTheme = {
	selectedPrefix: accent,
	selectedText: selection,
	description: muted,
	scrollInfo: muted,
	noMatch: muted,
};

export interface SkillBrowserActions {
	readonly close: () => void;
	readonly invalidate: () => void;
}

function wrapPlainText(value: string, columns: number): readonly string[] {
	const width = Math.max(1, columns);
	return sanitizeTerminalText(value)
		.split(/\r?\n/u)
		.flatMap((source) => {
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

export class SkillBrowserOverlay implements Component, Focusable {
	focused = false;
	private readonly skills: readonly SkillResource[];
	private readonly rowsProvider: () => number;
	private readonly actions: SkillBrowserActions;
	private readonly list: SelectList;
	private detail: SkillResource | undefined;
	private detailOffset = 0;
	private maxDetailOffset = 0;

	constructor(skills: readonly SkillResource[], rowsProvider: () => number, actions: SkillBrowserActions) {
		this.skills = skills;
		this.rowsProvider = rowsProvider;
		this.actions = actions;
		const items: SelectItem[] = skills.map((skill) => ({
			value: skill.id,
			label: `${sanitizeTerminalText(skill.name)} · ${skill.scope} · ${sanitizeTerminalText(skill.description)}`,
		}));
		this.list = new SelectList(items, 8, SKILL_SELECT_THEME, {
			minPrimaryColumnWidth: 16,
			maxPrimaryColumnWidth: 28,
		});
		this.list.onSelect = (item) => {
			this.detail = this.skills.find(({ id }) => id === item.value);
			this.detailOffset = 0;
			this.actions.invalidate();
		};
		this.list.onCancel = this.actions.close;
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		const maxRows = Math.max(1, Math.floor(this.rowsProvider()));
		return this.detail ? this.renderDetail(this.detail, columns, maxRows) : this.renderList(columns, maxRows);
	}

	handleInput(data: string): void {
		if (!this.detail) {
			this.list.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.detail = undefined;
			this.detailOffset = 0;
			this.actions.invalidate();
			return;
		}
		if (data.toLowerCase() === "q") {
			this.actions.close();
			return;
		}
		const page = Math.max(1, Math.floor(this.rowsProvider()) - 3);
		if (matchesKey(data, "pageUp")) this.detailOffset = Math.max(0, this.detailOffset - page);
		else if (matchesKey(data, "pageDown"))
			this.detailOffset = Math.min(this.maxDetailOffset, this.detailOffset + page);
		else if (matchesKey(data, "home")) this.detailOffset = 0;
		else if (matchesKey(data, "end")) this.detailOffset = this.maxDetailOffset;
		else if (matchesKey(data, "up")) this.detailOffset = Math.max(0, this.detailOffset - 1);
		else if (matchesKey(data, "down")) this.detailOffset = Math.min(this.maxDetailOffset, this.detailOffset + 1);
		else return;
		this.actions.invalidate();
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private renderList(columns: number, maxRows: number): string[] {
		const title = frameLine(accent(`Installed skills · ${this.skills.length}`), columns);
		const footer = frameLine(muted("built-in < user < project precedence"), columns);
		if (maxRows === 1) return [title];
		if (maxRows < 5) {
			this.list.setMaxVisible(Math.max(0, maxRows - 2));
			this.list.setScrollInfoVisible(false);
			return [title, ...this.list.render(columns), footer].slice(0, maxRows);
		}
		this.list.setMaxVisible(Math.max(1, maxRows - 5));
		this.list.setScrollInfoVisible(true);
		return [
			title,
			frameLine(muted("↑↓ navigate · Enter open · Esc close"), columns),
			"",
			...this.list.render(columns),
			footer,
		].slice(0, maxRows);
	}

	private renderDetail(skill: SkillResource, columns: number, maxRows: number): string[] {
		const compactHeight = maxRows < 6;
		const bodyRows = Math.max(0, maxRows - (compactHeight ? 2 : 3));
		const hint = columns < 48 ? "↑↓ scroll · Esc back · q close" : "↑↓/PgUp/PgDn scroll · Esc back · q close";
		const body = wrapPlainText(
			`${skill.description}\n\n${skill.instructions}\n\nSource: ${skill.sourcePath}`,
			columns,
		);
		this.maxDetailOffset = Math.max(0, body.length - bodyRows);
		this.detailOffset = Math.min(this.detailOffset, this.maxDetailOffset);
		const visible = body.slice(this.detailOffset, this.detailOffset + bodyRows);
		const title = frameLine(
			accent(ellipsizeCells(`${sanitizeTerminalText(skill.name)} · ${skill.scope}`, columns)),
			columns,
		);
		if (maxRows === 1) return [title];
		const footer = frameLine(
			muted(`${Math.min(body.length, this.detailOffset + visible.length)}/${body.length} rows`),
			columns,
		);
		return [
			title,
			...(compactHeight ? [] : [frameLine(muted(hint), columns)]),
			...visible.map((line) => frameLine(line ? text(line) : "", columns)),
			footer,
		].slice(0, maxRows);
	}
}
