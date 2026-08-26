import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { TuiLiveCore } from "./tui-live-state.ts";
import { accent, frameLine, muted, selection } from "./tui-text.ts";

const AUTH_SELECT_THEME: SelectListTheme = {
	selectedPrefix: accent,
	selectedText: selection,
	description: muted,
	scrollInfo: muted,
	noMatch: muted,
};

export class ProviderAuthPromptOverlay implements Component, Focusable {
	private readonly prompt: AuthPrompt;
	private readonly submit: (answer: string) => void;
	private readonly cancel: () => void;
	private readonly input: Input | undefined;
	private readonly list: SelectList | undefined;
	private _focused = false;

	constructor(prompt: AuthPrompt, submit: (answer: string) => void, cancel: () => void) {
		this.prompt = prompt;
		this.submit = submit;
		this.cancel = cancel;
		if (prompt.type === "select") {
			const items: SelectItem[] = prompt.options.map((option) => ({
				value: option.id,
				label: option.label,
				...(option.description ? { description: option.description } : {}),
			}));
			this.list = new SelectList(items, Math.min(8, items.length), AUTH_SELECT_THEME, {
				minPrimaryColumnWidth: 18,
				maxPrimaryColumnWidth: 34,
			});
			this.list.onSelect = (item) => this.submit(item.value);
			this.list.onCancel = this.cancel;
		} else {
			this.input = new Input();
			this.input.onSubmit = this.submit;
			this.input.onEscape = this.cancel;
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	render(width: number): string[] {
		const hint = this.prompt.type === "select" ? "↑↓ move · Enter select · Esc cancel" : "Enter submit · Esc cancel";
		return [
			frameLine(accent(this.prompt.message), width),
			frameLine(muted(hint), width),
			"",
			...(this.input ? this.renderInput(width) : (this.list?.render(width) ?? [])),
		];
	}

	handleInput(data: string): void {
		if (this.input) this.input.handleInput(data);
		else this.list?.handleInput(data);
	}

	invalidate(): void {
		this.input?.invalidate();
		this.list?.invalidate();
	}

	private renderInput(width: number): string[] {
		if (!this.input || this.prompt.type !== "secret") return this.input?.render(width) ?? [];
		const value = this.input.getValue();
		this.input.setValue("•".repeat([...value].length));
		const rendered = this.input.render(width);
		this.input.setValue(value);
		return rendered;
	}
}

export function promptProviderAuth(core: TuiLiveCore, prompt: AuthPrompt): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
		const finish = (answer?: string, error?: Error) => {
			if (settled) return;
			settled = true;
			prompt.signal?.removeEventListener("abort", abort);
			handle?.hide();
			if (error) reject(error);
			else resolve(answer ?? "");
		};
		const abort = () => finish(undefined, new Error("Login cancelled"));
		const overlay = new ProviderAuthPromptOverlay(prompt, (answer) => finish(answer), abort);
		handle = core.ui.showOverlay(overlay, {
			width: Math.max(36, Math.min(76, (process.stdout.columns || 120) - 4)),
			maxHeight: "40%",
			anchor: "top-center",
			margin: 2,
		});
		if (prompt.signal?.aborted) abort();
		else prompt.signal?.addEventListener("abort", abort, { once: true });
	});
}
