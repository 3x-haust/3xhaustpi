import { appKeyHint } from "./tui-app-keybindings.ts";
import type { TuiAuxiliaryOverlayState } from "./tui-auxiliary-overlay.ts";

export function auxiliaryOverlayHint(
	state: TuiAuxiliaryOverlayState,
	promotable: boolean,
	review: { readonly current: number; readonly total: number; readonly reachedEnd: boolean },
): string {
	if (state === "confirm-promotion") {
		return `Review ${review.current}/${review.total} · ${appKeyHint("tui.select.up")}${appKeyHint(
			"tui.select.down",
		)}/${appKeyHint("tui.select.pageUp")}/${appKeyHint("tui.select.pageDown")} · ${appKeyHint(
			"app.auxiliary.reviewStart",
		)}/${appKeyHint("app.auxiliary.reviewEnd")} · ${
			review.reachedEnd ? `${appKeyHint("tui.select.confirm")} promote` : "read to end"
		} · ${appKeyHint("tui.select.cancel")} cancel`;
	}
	if (state === "running") {
		return `${appKeyHint("tui.input.submit")} queue reply · ${appKeyHint("tui.select.cancel")} cancel and close`;
	}
	const input = `${appKeyHint("tui.input.submit")} send · ${appKeyHint("tui.input.newLine")} newline`;
	return promotable
		? `${input} · ${appKeyHint("app.auxiliary.promote")} promote · ${appKeyHint("tui.select.cancel")} close`
		: `${input} · ${appKeyHint("tui.select.cancel")} close`;
}
