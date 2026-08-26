import { matchesKey } from "@earendil-works/pi-tui";
import { TUI_PRIMARY_COMMANDS, type TuiCommandGroup } from "./tui-command-catalog.ts";
import type { TuiSigintTarget } from "./tui-contract.ts";
import { isTuiTranscriptScrollInput } from "./tui-layout-frame.ts";
import { cellWidth, dim, ellipsizeCells, frameLine, stripAnsi, text } from "./tui-text.ts";

export function bindTuiSigint(target: TuiSigintTarget, requestExit: () => void): () => void {
	target.on("SIGINT", requestExit);
	return () => target.removeListener("SIGINT", requestExit);
}
export function isTuiCtrlC(value: string): boolean {
	return matchesKey(value, "ctrl+c");
}

export interface TuiCommand {
	readonly name: string;
	readonly argument: string;
}
export interface TuiModelLike {
	readonly id: string;
}
export function parseTuiCommand(value: string): TuiCommand | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const separator = trimmed.indexOf(" ");
	return {
		name: trimmed.slice(1, separator === -1 ? undefined : separator).toLowerCase(),
		argument: separator === -1 ? "" : trimmed.slice(separator + 1).trim(),
	};
}
export function formatModelCommandLines(models: readonly TuiModelLike[], currentModel: string): string[] {
	if (models.length === 0) return ["No models are available for the current provider."];
	return models.map((candidate) => `${candidate.id === currentModel ? "*" : " "} ${candidate.id}`);
}
export function orderModelsForPicker<T extends TuiModelLike>(models: readonly T[], currentModel: string): T[] {
	return [...models].sort((left, right) => Number(right.id === currentModel) - Number(left.id === currentModel));
}
export function resolveModelSelection(
	models: readonly TuiModelLike[],
	requestedModel: string,
): { readonly ok: true; readonly model: string } | { readonly ok: false; readonly message: string } {
	const selected = models.find((candidate) => candidate.id === requestedModel);
	return selected ? { ok: true, model: selected.id } : { ok: false, message: `Unknown model: ${requestedModel}` };
}

export type TuiCtrlCAction = "clear-input" | "exit";
export function resolveCtrlCAction(inputText: string): TuiCtrlCAction {
	return inputText ? "clear-input" : "exit";
}
export type TuiInputAction =
	| "clear-input"
	| "exit"
	| "approve-approval"
	| "reject-approval"
	| "consume-approval"
	| "pass-approval-input"
	| "open-history"
	| "open-help"
	| "recall-pending"
	| "interrupt"
	| "pass";
export function shouldDeferTuiInputToImageViewer(viewerOpen: boolean, action: TuiInputAction): boolean {
	return viewerOpen && action !== "interrupt";
}
export function resolveTuiInputAction(
	value: string,
	context: {
		readonly approvalPending: boolean;
		readonly approvalReviewable?: boolean;
		readonly active: boolean;
		readonly composerText: string;
		readonly pendingCount?: number;
		readonly overlayOpen?: boolean;
	},
): TuiInputAction {
	if (context.approvalPending) {
		if (isTuiCtrlC(value)) return "reject-approval";
		if (matchesKey(value, "escape")) return "reject-approval";
		if (isTuiTranscriptScrollInput(value, "")) return "pass";
		if (value.startsWith("\u001b[200~") && value.endsWith("\u001b[201~")) return "pass-approval-input";
		if (context.composerText) return "pass-approval-input";
		if (value.toLowerCase() === "n") return "reject-approval";
		if (value.toLowerCase() === "y")
			return context.approvalReviewable === false ? "consume-approval" : "approve-approval";
		if (/^[^\u0000-\u001f\u007f]+$/u.test(value)) return "pass-approval-input";
		return "consume-approval";
	}
	if (context.overlayOpen) return "pass";
	if (isTuiCtrlC(value)) return resolveCtrlCAction(context.composerText);
	if (context.active && !context.composerText && (context.pendingCount ?? 0) > 0 && matchesKey(value, "up"))
		return "recall-pending";
	if (matchesKey(value, "ctrl+t")) return "open-history";
	if (!context.composerText && value === "?") return "open-help";
	if (context.active && matchesKey(value, "escape")) return "interrupt";
	return "pass";
}

const COMMAND_GROUP_ORDER: readonly TuiCommandGroup[] = ["conversation", "work", "environment", "system"];
const HELP_COMMAND_GROUPS = COMMAND_GROUP_ORDER.map((group) =>
	TUI_PRIMARY_COMMANDS.filter((command) => command.group === group).map(({ usage }) => usage),
);
export function formatHelpCommandLines(columns = 120): string[] {
	const width = Math.max(1, columns - cellWidth("• "));
	const lines = [text("Commands")];
	for (const group of HELP_COMMAND_GROUPS) {
		let line = "";
		for (const token of group) {
			const next = line ? `${line}  ${dim("•")} ${token}` : token;
			if (cellWidth(stripAnsi(next)) > width && line) {
				lines.push(dim(line));
				line = token;
			} else line = next;
		}
		if (line) lines.push(dim(line));
	}
	lines.push(text("Keys"), dim("↑ edit pending while working"));
	return lines.map((line) => frameLine(ellipsizeCells(line, width), width));
}
