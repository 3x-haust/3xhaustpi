import {
	type Component,
	type Focusable,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import { accent, ellipsizeCells, failure, frameLine, muted, sanitizeTerminalText, selection } from "./tui-text.ts";

export type SettingsReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SettingsModelEntry {
	readonly provider: string;
	readonly model: string;
}

export interface SettingsOverlaySnapshot {
	readonly models: readonly SettingsModelEntry[];
	readonly currentModel: SettingsModelEntry;
	readonly reasoning: SettingsReasoningLevel;
	readonly cacheWarmEnabled: boolean;
}

export interface SettingsOverlayActions {
	readonly selectModel: (entry: SettingsModelEntry) => Promise<SettingsOverlaySnapshot>;
	readonly selectReasoning: (level: SettingsReasoningLevel) => Promise<SettingsOverlaySnapshot>;
	readonly setCacheWarm: (enabled: boolean) => Promise<SettingsOverlaySnapshot>;
	readonly openSkills: () => void;
	readonly openMcpServers: () => void;
	readonly openHooks: () => void;
	readonly openComputerAccess: () => void;
	readonly close: () => void;
	readonly invalidate: () => void;
}

type SettingsDepth = "root" | "model" | "reasoning" | "cache-warm" | "integrations";

const REASONING_LEVELS: readonly SettingsReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const SETTINGS_THEME: SelectListTheme = {
	selectedPrefix: accent,
	selectedText: selection,
	description: muted,
	scrollInfo: muted,
	noMatch: muted,
};

export class SettingsOverlay implements Component, Focusable {
	focused = false;
	private snapshot: SettingsOverlaySnapshot;
	private readonly rowsProvider: () => number;
	private readonly actions: SettingsOverlayActions;
	private depth: SettingsDepth;
	private list: SelectList;
	private itemCount = 0;
	private busy = false;
	private error: string | undefined;
	private query = "";

	constructor(
		snapshot: SettingsOverlaySnapshot,
		rowsProvider: () => number,
		actions: SettingsOverlayActions,
		initialDepth: SettingsDepth = "root",
	) {
		this.snapshot = snapshot;
		this.rowsProvider = rowsProvider;
		this.actions = actions;
		this.depth = initialDepth;
		this.list = this.createList();
	}

	render(width: number): string[] {
		const columns = Math.max(1, Math.min(76, Math.floor(width)));
		const maxRows = Math.max(1, Math.floor(this.rowsProvider()));
		const title = frameLine(accent(this.title()), columns);
		if (maxRows === 1) return [title];

		const footer = frameLine(
			this.error ? failure(this.error) : muted(this.busy ? "Applying selection…" : "Esc back/close"),
			columns,
		);
		if (maxRows < 5) {
			this.list.setMaxVisible(Math.max(0, maxRows - 2));
			this.list.setScrollInfoVisible(false);
			return [title, ...this.list.render(columns), footer].slice(0, maxRows);
		}

		const bodyCapacity = maxRows - 4;
		const scrolls = this.itemCount > bodyCapacity;
		this.list.setMaxVisible(Math.max(1, bodyCapacity - (scrolls ? 1 : 0)));
		this.list.setScrollInfoVisible(scrolls);
		return [
			title,
			frameLine(muted("↑↓ navigate · Enter select/open · Esc back"), columns),
			"",
			...this.list.render(columns),
			footer,
		].slice(0, maxRows);
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (this.depth === "model") {
			if (matchesKey(data, "escape") && this.query) {
				this.query = "";
				this.list.setFilter("");
				this.actions.invalidate();
				return;
			}
			if (matchesKey(data, "backspace")) {
				this.query = Array.from(this.query).slice(0, -1).join("");
				this.list.setFilter(this.query);
				this.actions.invalidate();
				return;
			}
			const printable = sanitizeTerminalText(data);
			if (printable && /^[\p{L}\p{N}._:/-]+$/u.test(printable)) {
				this.query += printable;
				this.list.setFilter(this.query);
				this.actions.invalidate();
				return;
			}
		}
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private title(): string {
		if (this.depth === "model") return `Settings · Model${this.query ? ` · Filter: ${this.query}` : ""}`;
		if (this.depth === "reasoning") return "Settings · Reasoning";
		if (this.depth === "cache-warm") return "Settings · Cache warming";
		if (this.depth === "integrations") return "Settings · Integrations";
		return "Settings";
	}

	private createList(): SelectList {
		const entries = this.entries();
		this.itemCount = entries.length;
		const callbacks = new Map(entries.map(({ item, select }) => [item.value, select]));
		const list = new SelectList(
			entries.map(({ item }) => item),
			8,
			SETTINGS_THEME,
			{ minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 36 },
		);
		list.onSelect = (item) => callbacks.get(item.value)?.();
		list.onCancel = () => this.back();
		list.onSelectionChange = () => this.actions.invalidate();
		if (this.depth === "model" && this.query) list.setFilter(this.query);
		return list;
	}

	private entries(): readonly { readonly item: SelectItem; readonly select: () => void }[] {
		if (this.depth === "root") {
			return [
				{
					item: {
						value: "model",
						label: "Model",
						description: this.safeModel(this.snapshot.currentModel),
					},
					select: () => this.open("model"),
				},
				{
					item: { value: "reasoning", label: "Reasoning", description: this.snapshot.reasoning },
					select: () => this.open("reasoning"),
				},
				{
					item: {
						value: "cache-warm",
						label: "Cache warming",
						description: this.snapshot.cacheWarmEnabled ? "Eligible work" : "Off",
					},
					select: () => this.open("cache-warm"),
				},
				{
					item: { value: "integrations", label: "Integrations", description: "Skills · MCP · Hooks · Computer" },
					select: () => this.open("integrations"),
				},
			];
		}
		if (this.depth === "model") {
			const models = [
				...this.snapshot.models.filter((entry) => this.isCurrentModel(entry)),
				...this.snapshot.models.filter((entry) => !this.isCurrentModel(entry)),
			];
			return models.map((entry) => ({
				item: {
					value: this.safeModel(entry),
					label: `${this.isCurrentModel(entry) ? "●" : "○"} ${this.safeModel(entry)}`,
					description: this.isCurrentModel(entry) ? "current" : undefined,
				},
				select: () => this.apply(() => this.actions.selectModel(entry)),
			}));
		}
		if (this.depth === "reasoning") {
			return REASONING_LEVELS.map((level) => ({
				item: { value: level, label: `${level === this.snapshot.reasoning ? "●" : "○"} ${level}` },
				select: () => this.apply(() => this.actions.selectReasoning(level)),
			}));
		}
		if (this.depth === "cache-warm") {
			return [
				{
					item: {
						value: "cache-warm-off",
						label: `${this.snapshot.cacheWarmEnabled ? "○" : "●"} Off`,
						description: "No background provider requests",
					},
					select: () => this.apply(() => this.actions.setCacheWarm(false)),
				},
				{
					item: {
						value: "cache-warm-on",
						label: `${this.snapshot.cacheWarmEnabled ? "●" : "○"} Eligible work`,
						description: "May send paid background requests",
					},
					select: () => this.apply(() => this.actions.setCacheWarm(true)),
				},
			];
		}
		return [
			{ item: { value: "skills", label: "Skills" }, select: this.actions.openSkills },
			{ item: { value: "mcp", label: "MCP servers" }, select: this.actions.openMcpServers },
			{ item: { value: "hooks", label: "Hooks" }, select: this.actions.openHooks },
			{ item: { value: "computer", label: "Computer access" }, select: this.actions.openComputerAccess },
		];
	}

	private safeModel(entry: SettingsModelEntry): string {
		return sanitizeTerminalText(`${entry.provider}/${entry.model}`);
	}

	private isCurrentModel(entry: SettingsModelEntry): boolean {
		return entry.provider === this.snapshot.currentModel.provider && entry.model === this.snapshot.currentModel.model;
	}

	private open(depth: Exclude<SettingsDepth, "root">): void {
		this.depth = depth;
		this.query = "";
		this.error = undefined;
		this.list = this.createList();
		this.actions.invalidate();
	}

	private back(): void {
		if (this.depth === "root") {
			this.actions.close();
			return;
		}
		this.depth = "root";
		this.query = "";
		this.error = undefined;
		this.list = this.createList();
		this.actions.invalidate();
	}

	private apply(operation: () => Promise<SettingsOverlaySnapshot>): void {
		this.busy = true;
		this.error = undefined;
		this.actions.invalidate();
		void operation()
			.then((snapshot) => {
				this.snapshot = snapshot;
				this.list = this.createList();
			})
			.catch((cause) => {
				this.error = ellipsizeCells(cause instanceof Error ? cause.message : String(cause), 72);
			})
			.finally(() => {
				this.busy = false;
				this.actions.invalidate();
			});
	}
}
