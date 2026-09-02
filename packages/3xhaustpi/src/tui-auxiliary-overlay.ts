import { type Component, Editor, type EditorTheme, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { APP_KEYBINDINGS } from "./tui-app-keybindings.ts";
import { auxiliaryOverlayHint } from "./tui-auxiliary-hints.ts";
import { wrapAuxiliaryText } from "./tui-auxiliary-text.ts";
import type {
	TuiAuxiliaryKind,
	TuiAuxiliaryOverlayActions,
	TuiAuxiliaryTranscriptEntry,
	TuiReviewedAuxiliaryAnswer,
} from "./tui-auxiliary-types.ts";
import { accent, failure, frameLine, muted, sanitizeTerminalText, selection, success, text } from "./tui-text.ts";

export type TuiAuxiliaryOverlayState = "ready" | "running" | "failure" | "confirm-promotion" | "promoting" | "promoted";

const PROMOTION_AUTHORIZATIONS = new WeakMap<TuiAuxiliaryOverlay, TuiReviewedAuxiliaryAnswer>();

export function consumeTuiPromotionAuthorization(overlay: TuiAuxiliaryOverlay): TuiReviewedAuxiliaryAnswer | undefined {
	const authorization = PROMOTION_AUTHORIZATIONS.get(overlay);
	PROMOTION_AUTHORIZATIONS.delete(overlay);
	return authorization;
}

const EDITOR_THEME: EditorTheme = {
	borderColor: muted,
	selectList: {
		selectedPrefix: accent,
		selectedText: selection,
		description: muted,
		scrollInfo: muted,
		noMatch: muted,
	},
};

export class TuiAuxiliaryOverlay implements Component, Focusable {
	readonly editor: Editor;
	private readonly kind: TuiAuxiliaryKind;
	private readonly rowsProvider: () => number;
	private readonly actions: TuiAuxiliaryOverlayActions;
	#entries: readonly TuiAuxiliaryTranscriptEntry[] = [];
	#state: TuiAuxiliaryOverlayState = "ready";
	private error: string | undefined;
	private promotedSourceIds = new Set<string>();
	private focusedValue = false;
	private scrollOffset = 0;
	private maxScrollOffset = 0;
	private bodyRows = 1;
	private bodyLength = 0;
	#reviewSourceId: string | undefined;
	#reviewedToEnd = false;

	constructor(ui: TUI, kind: TuiAuxiliaryKind, rowsProvider: () => number, actions: TuiAuxiliaryOverlayActions) {
		this.kind = kind;
		this.rowsProvider = rowsProvider;
		this.actions = actions;
		this.editor = new Editor(ui, EDITOR_THEME, {
			paddingX: 1,
			promptPrefix: `${accent(">")} `,
			bottomBorder: false,
			maxVisibleLines: 3,
		});
		this.editor.onSubmit = (value) => {
			const message = value.trim();
			if (!message || this.#state === "promoting" || this.#state === "confirm-promotion") return;
			this.editor.setText("");
			this.actions.submit(message);
		};
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.editor.focused = value;
	}

	setTranscript(entries: readonly TuiAuxiliaryTranscriptEntry[]): void {
		this.#entries = entries;
		this.actions.invalidate();
	}

	setState(state: TuiAuxiliaryOverlayState, error?: string): void {
		this.#state = state;
		if (state === "ready" || state === "failure") {
			this.#reviewSourceId = undefined;
			PROMOTION_AUTHORIZATIONS.delete(this);
		}
		this.error = error ? sanitizeTerminalText(error).replace(/\s+/gu, " ").trim() : undefined;
		this.actions.invalidate();
	}

	markPromoted(sourceId: string): void {
		this.promotedSourceIds.add(sourceId);
		this.#state = "promoted";
		this.#reviewSourceId = undefined;
		PROMOTION_AUTHORIZATIONS.delete(this);
		this.actions.invalidate();
	}

	latestPromotable(): TuiAuxiliaryTranscriptEntry | undefined {
		return this.#entries
			.filter(
				(entry) =>
					entry.role === "assistant" &&
					entry.sourceId !== undefined &&
					!this.promotedSourceIds.has(entry.sourceId),
			)
			.at(-1);
	}

	render(width: number): string[] {
		const columns = Math.max(1, Math.floor(width));
		const terminalRows = Math.max(1, Math.floor(this.rowsProvider()));
		const maxRows = columns < 56 || terminalRows < 12 ? terminalRows : Math.max(8, Math.floor(terminalRows * 0.7));
		const title = frameLine(`${accent(this.title())} · ${this.stateLabel()}`, columns);
		if (maxRows === 1) return [title];
		this.editor.setMaxVisibleLines(Math.max(1, Math.min(3, maxRows - 4)));
		const editorRows = this.editor.render(columns);
		const reviewing = this.#state === "confirm-promotion" || this.#state === "promoting";
		const body = (reviewing ? this.promotionReviewEntries() : this.#entries).flatMap((entry) =>
			wrapAuxiliaryText(`${entry.role === "user" ? "You" : "3xhaust"}\n${entry.text}`, columns).map((line) =>
				frameLine(line ? text(line) : "", columns),
			),
		);
		this.bodyRows = Math.max(1, maxRows - editorRows.length - 2);
		this.bodyLength = body.length;
		this.maxScrollOffset = Math.max(0, body.length - this.bodyRows);
		if (reviewing) {
			this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
			if (this.maxScrollOffset === 0) this.#reviewedToEnd = true;
		} else {
			this.scrollOffset = this.maxScrollOffset;
		}
		const visible = body.slice(this.scrollOffset, this.scrollOffset + this.bodyRows);
		const hint = frameLine(muted(this.hint()), columns);
		return [title, ...visible, ...editorRows, hint].slice(0, maxRows);
	}

	handleInput(data: string): void {
		if (this.#state === "confirm-promotion") {
			if (APP_KEYBINDINGS.matches(data, "tui.select.cancel")) {
				this.#state = "ready";
				this.#reviewSourceId = undefined;
				this.actions.invalidate();
			} else if (this.scrollReview(data)) {
				this.actions.invalidate();
			} else if (APP_KEYBINDINGS.matches(data, "tui.select.confirm") && this.#reviewedToEnd) {
				const reviewed = this.reviewedAnswer();
				if (reviewed) {
					PROMOTION_AUTHORIZATIONS.set(this, reviewed);
					this.#state = "promoting";
					this.actions.promote();
				}
			}
			return;
		}
		const promotable = this.latestPromotable();
		if (
			APP_KEYBINDINGS.matches(data, "app.auxiliary.promote") &&
			promotable &&
			this.#state !== "running" &&
			this.#state !== "promoting"
		) {
			this.#state = "confirm-promotion";
			this.#reviewSourceId = promotable.sourceId;
			this.scrollOffset = 0;
			this.#reviewedToEnd = false;
			this.actions.invalidate();
			return;
		}
		if (APP_KEYBINDINGS.matches(data, "tui.select.cancel")) {
			if (this.#state === "running") this.actions.cancel();
			this.actions.close();
			return;
		}
		this.editor.handleInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private title(): string {
		return this.kind === "side" ? "Side Chat · isolated" : "BTW · main-aware";
	}

	private stateLabel(): string {
		if (this.#state === "running") return text("• thinking");
		if (this.#state === "failure") return failure(`× ${this.error ?? "failed"}`);
		if (this.#state === "confirm-promotion") return text("Review answer before promotion");
		if (this.#state === "promoting") return text("• promoting");
		if (this.#state === "promoted") return success("✓ promoted");
		return text("• ready");
	}

	private hint(): string {
		return auxiliaryOverlayHint(this.#state, this.latestPromotable() !== undefined, {
			current: Math.min(this.bodyLength, this.scrollOffset + this.bodyRows),
			total: this.bodyLength,
			reachedEnd: this.#reviewedToEnd,
		});
	}

	private promotionReviewEntries(): readonly TuiAuxiliaryTranscriptEntry[] {
		const index = this.#entries.findIndex(({ sourceId }) => sourceId === this.#reviewSourceId);
		if (index < 0) return [];
		const previous = this.#entries[index - 1];
		return previous?.role === "user" ? [previous, this.#entries[index]!] : [this.#entries[index]!];
	}

	private reviewedAnswer(): TuiReviewedAuxiliaryAnswer | undefined {
		const index = this.#entries.findIndex(
			(entry) => entry.role === "assistant" && entry.sourceId === this.#reviewSourceId,
		);
		const answer = this.#entries[index];
		const question = this.#entries[index - 1];
		if (!answer?.sourceId || answer.role !== "assistant" || question?.role !== "user") return undefined;
		return { sourceId: answer.sourceId, question: question.text, answer: answer.text };
	}

	private scrollReview(data: string): boolean {
		const next = APP_KEYBINDINGS.matches(data, "app.auxiliary.reviewStart")
			? 0
			: APP_KEYBINDINGS.matches(data, "app.auxiliary.reviewEnd")
				? this.maxScrollOffset
				: this.scrollOffset +
					(APP_KEYBINDINGS.matches(data, "tui.select.up")
						? -1
						: APP_KEYBINDINGS.matches(data, "tui.select.down")
							? 1
							: APP_KEYBINDINGS.matches(data, "tui.select.pageUp")
								? -this.bodyRows
								: APP_KEYBINDINGS.matches(data, "tui.select.pageDown")
									? this.bodyRows
									: 0);
		if (
			next === this.scrollOffset &&
			!APP_KEYBINDINGS.matches(data, "app.auxiliary.reviewStart") &&
			!APP_KEYBINDINGS.matches(data, "app.auxiliary.reviewEnd")
		) {
			return false;
		}
		this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset, next));
		if (this.scrollOffset === this.maxScrollOffset) this.#reviewedToEnd = true;
		return true;
	}
}
