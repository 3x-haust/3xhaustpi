import type { TuiViewState } from "./tui-contract.ts";
import {
	dim,
	ellipsizeCells,
	failure,
	grayscaleShimmer,
	muted,
	sanitizeTerminalText,
	stripAnsi,
	text,
	warning,
} from "./tui-text.ts";

export interface TuiResponseMetrics {
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite?: number | null;
	readonly durationMs: number;
}

export function reportedContextTokens(
	metrics: Pick<TuiResponseMetrics, "input" | "output" | "cacheRead" | "cacheWrite">,
): number | undefined {
	if (
		metrics.input === null ||
		metrics.output === null ||
		metrics.cacheRead === null ||
		metrics.cacheWrite === null ||
		metrics.cacheWrite === undefined
	)
		return undefined;
	return metrics.input + metrics.output + metrics.cacheRead + metrics.cacheWrite;
}

export function providerReportedCacheHitRatio(
	_uncachedSuffix: number | null,
	cacheRead: number | null,
	cacheWrite: number | null | undefined = 0,
): number | undefined {
	if (cacheRead === null || cacheRead <= 0) return undefined;
	const reusablePrefix = cacheRead + (cacheWrite ?? 0);
	return reusablePrefix > 0 ? Math.min(1, Math.max(0, cacheRead / reusablePrefix)) : undefined;
}

export function formatResponseMetrics(metrics: TuiResponseMetrics): string {
	const throughput =
		metrics.output !== null && metrics.durationMs > 0
			? `TPS ${(metrics.output / (metrics.durationMs / 1_000)).toFixed(1)} tok/s`
			: undefined;
	const cacheRatio = providerReportedCacheHitRatio(metrics.input, metrics.cacheRead, metrics.cacheWrite);
	const cache = cacheRatio === undefined ? undefined : `Cache hit ${(cacheRatio * 100).toFixed(1)}%`;
	const duration = `${(Math.max(0, metrics.durationMs) / 1_000).toFixed(1)}s`;
	if (throughput && cache) return `${throughput}. ${cache}, ${duration}`;
	if (throughput) return `${throughput}, ${duration}`;
	if (cache) return `${cache}, ${duration}`;
	return duration;
}

export interface TuiActivityState {
	readonly status: TuiViewState["status"];
	readonly detail?: string;
	readonly animationFrame?: number;
	readonly activeCount?: number;
	readonly queuedCount?: number;
	readonly resumable?: boolean;
	readonly canceled?: boolean;
	readonly detachedNew?: number;
	readonly metrics?: string;
}

function activityDetail(value: string, columns: number): string {
	return ellipsizeCells(sanitizeTerminalText(value).replace(/\s+/gu, " ").trim(), Math.max(1, columns));
}

function baseTuiActivityLine(state: TuiActivityState, columns: number): string {
	const queuedCount = state.queuedCount ?? 0;
	const activeCount = state.activeCount ?? 0;
	const detail = state.detail ? activityDetail(state.detail, Math.max(8, columns - 14)) : "";
	const bullet = dim("•");
	if (state.status === "awaiting-approval")
		return `${bullet} ${warning("Review")} ${dim(`(${detail || "approval required"})`)}`;
	if (state.canceled) return `${bullet} ${warning("Canceled")}`;
	if (state.status === "error") return `${bullet} ${failure("Failed")} ${dim(`(${detail || "ready"})`)}`;
	if (state.status === "running" || activeCount > 0) {
		const target = detail || (activeCount > 1 ? `${activeCount} active` : "");
		const pending = queuedCount > 0 ? `${queuedCount} pending` : "";
		const suffix = [target, pending, "esc to interrupt"].filter(Boolean).join(` ${dim("·")} `);
		if (state.animationFrame !== undefined)
			return `${bullet} ${grayscaleShimmer(`Working (${stripAnsi(suffix)})`, state.animationFrame)}`;
		return `${bullet} ${text("Working")} ${dim(`(${suffix})`)}`;
	}
	return state.metrics ? muted(activityDetail(state.metrics, columns)) : "";
}

export function formatTuiActivityLine(state: TuiActivityState, columns = 120): string {
	const line = baseTuiActivityLine(state, columns);
	const detachedNew = state.detachedNew ?? 0;
	const full = detachedNew > 0 ? `${line} ${dim(`· ↓ ${detachedNew} new · Alt+End latest`)}` : line;
	return ellipsizeCells(full, Math.max(1, columns - 1));
}

export function retainTuiActivityDetail(current: string, next: string | undefined): string {
	return next ?? current;
}

export function updateTuiCapabilityActivity(
	active: readonly string[],
	capability: string,
	transition: "started" | "completed",
): string[] {
	if (transition === "started") return [...active, capability];
	const completedIndex = active.lastIndexOf(capability);
	return completedIndex === -1 ? [...active] : active.filter((_, index) => index !== completedIndex);
}

export function formatTuiStatusLine(
	status: TuiViewState["status"],
	detail: string,
	queuedCount: number,
	activeCount = 0,
): string {
	return formatTuiActivityLine({ status, detail, queuedCount, activeCount });
}
