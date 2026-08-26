import { contextUsageLabel } from "./tui-context-meter.ts";
import type { TuiViewState } from "./tui-contract.ts";
import { cellWidth, dim, ellipsizeCells, muted, stripAnsi, text } from "./tui-text.ts";

export type TuiFooterSegmentId = "model" | "context" | "tasks" | "provider";
export const TUI_FOOTER_SEGMENT_PRIORITY: readonly { readonly id: TuiFooterSegmentId; readonly priority: number }[] = [
	{ id: "context", priority: 1 },
	{ id: "model", priority: 2 },
	{ id: "provider", priority: 3 },
	{ id: "tasks", priority: 4 },
] as const;
interface FooterSegmentRender {
	readonly id: TuiFooterSegmentId;
	readonly compact: string;
	readonly ideal: string;
}
function footerSegmentRender(id: TuiFooterSegmentId, state: TuiViewState): FooterSegmentRender {
	const thinking = state.thinkingLevel ? `:${state.thinkingLevel}` : "";
	if (id === "model") {
		const model = `${state.model}${thinking}`;
		return { id, compact: text(model), ideal: text(model) };
	}
	if (id === "context")
		return {
			id,
			compact: muted(contextUsageLabel(state.contextTokens, state.contextLimit, "meter") ?? "Ctx —"),
			ideal: muted(contextUsageLabel(state.contextTokens, state.contextLimit, "ratio") ?? "context —"),
		};
	if (id === "tasks") {
		const tasks = state.activeTasks ?? 0;
		const queue = state.queuedRequests.length;
		return { id, compact: muted(`q${queue}/t${tasks}`), ideal: muted(`queue ${queue} · tasks ${tasks}`) };
	}
	return { id, compact: dim(state.provider), ideal: dim(`${state.provider} auto`) };
}
export function footerSegmentOrder(): readonly TuiFooterSegmentId[] {
	return TUI_FOOTER_SEGMENT_PRIORITY.map((segment) => segment.id);
}
function orderedFooterSegments(state: TuiViewState): readonly FooterSegmentRender[] {
	return [...TUI_FOOTER_SEGMENT_PRIORITY]
		.filter((segment) => segment.id !== "tasks" || (state.activeTasks ?? 0) > 0 || state.queuedRequests.length > 0)
		.sort((left, right) => left.priority - right.priority)
		.map((segment) => footerSegmentRender(segment.id, state));
}
function joinSegments(segments: readonly string[]): string {
	return segments.join(`  ${dim("•")} `);
}
function segmentLineWidth(segments: readonly string[]): number {
	return cellWidth(stripAnsi(joinSegments(segments)));
}
export function formatStatusFooter(state: TuiViewState, columns = 120): string {
	const ordered = orderedFooterSegments(state).filter((segment) => columns >= 60 || segment.id !== "provider");
	const admitted: string[] = [];
	for (const segment of ordered) {
		const next = [...admitted, segment.compact];
		if (segmentLineWidth(next) <= columns || admitted.length === 0) admitted.push(segment.compact);
		else break;
	}
	const promoted = [...admitted];
	for (const [index, segment] of ordered.entries()) {
		if (index >= promoted.length) break;
		const next = [...promoted];
		next[index] = segment.ideal;
		if (segmentLineWidth(next) <= columns) promoted[index] = segment.ideal;
	}
	return ellipsizeCells(joinSegments(promoted), columns);
}
