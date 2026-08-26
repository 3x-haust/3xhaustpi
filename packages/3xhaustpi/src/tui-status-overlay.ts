import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import type { CacheWarmSnapshot } from "./cache-warm-controller.ts";
import { contextUsageLabel } from "./tui-context-meter.ts";
import { formatExecutionGraphLines } from "./tui-execution-view.ts";
import type { TuiExecutionProjection } from "./tui-operation-types.ts";
import { accent, ellipsizeCells, frameLine, muted, sanitizeTerminalText, text } from "./tui-text.ts";

const MAX_OVERLAY_COLUMNS = 76;
const UNKNOWN = "—";

export interface TuiLatestResponseMetrics {
	/** Origin of these turn-local measurements, for example "provider turn". */
	readonly source?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly tokensPerSecond?: number;
	readonly cacheHitPercent?: number;
	readonly durationMs?: number;
}

export interface TuiStatusSnapshot {
	readonly projectPath: string;
	readonly provider: string;
	readonly model: string;
	readonly reasoning: string;
	readonly phase: string;
	readonly sessionId?: string;
	readonly contextTokens?: number;
	readonly contextLimit?: number;
	/** Measurements for only the latest response, never cumulative session usage. */
	readonly latestResponse?: TuiLatestResponseMetrics;
	readonly cacheWarm?: CacheWarmSnapshot;
	readonly execution?: TuiExecutionProjection;
	readonly goal?: string;
	readonly activeCount: number;
	readonly pendingCount: number;
	readonly changedFileCount?: number;
}

export interface TuiStatusOverlayActions {
	readonly close: () => void;
	readonly invalidate: () => void;
}

function clean(value: string | undefined): string {
	const visible = sanitizeTerminalText(value ?? "")
		.replace(/\s+/gu, " ")
		.trim();
	return visible || UNKNOWN;
}

function measurement(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactNumber(value: number): string {
	if (value < 1_000) return Number.isInteger(value) ? String(value) : value.toFixed(1);
	const scaled = value / 1_000;
	return `${scaled >= 100 || Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}K`;
}

function count(value: number | undefined, label: string): string | undefined {
	const known = measurement(value);
	return known === undefined ? undefined : `${compactNumber(known)} ${label}`;
}

function field(label: string, value: string): string {
	return `${muted(label)}  ${text(value)}`;
}

function contextLabel(snapshot: TuiStatusSnapshot): string {
	const used = measurement(snapshot.contextTokens);
	const limit = measurement(snapshot.contextLimit);
	return contextUsageLabel(used, limit, "ratio") ?? UNKNOWN;
}

function latestResponseLabel(metrics: TuiLatestResponseMetrics | undefined): string {
	if (!metrics) return UNKNOWN;
	const throughput = measurement(metrics.tokensPerSecond);
	const cache = measurement(metrics.cacheHitPercent);
	const duration = measurement(metrics.durationMs);
	const parts = [
		count(metrics.inputTokens, "in"),
		count(metrics.outputTokens, "out"),
		throughput === undefined ? undefined : `${compactNumber(throughput)} tok/s`,
		cache === undefined ? undefined : `${cache.toFixed(1)}% cache`,
		duration === undefined ? undefined : `${(duration / 1_000).toFixed(1)}s`,
	].filter((value): value is string => value !== undefined);
	return parts.length > 0 ? parts.join(" · ") : UNKNOWN;
}

export function cacheWarmStatusLabel(
	snapshot: CacheWarmSnapshot | undefined,
	formatTime: (timestamp: number) => string = (timestamp) =>
		new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): string {
	if (!snapshot || !snapshot.enabled || snapshot.state === "off") return "Off";
	if (snapshot.state === "warming") return "Warming";
	if (snapshot.state === "unavailable") return "On · unavailable for current model";
	if (snapshot.state === "waiting" || snapshot.nextWakeAt === undefined) return "On · waiting for eligible work";
	const prefix = snapshot.state === "retry" ? "Retry" : "Next wake";
	const iteration = snapshot.iteration > 0 ? ` · iteration ${snapshot.iteration}` : "";
	const savings =
		snapshot.estimatedSavingsUsd === undefined ? "" : ` · est. savings $${snapshot.estimatedSavingsUsd.toFixed(2)}`;
	return `${prefix} ${formatTime(snapshot.nextWakeAt)} local${iteration}${savings}`;
}

export class TuiStatusOverlay implements Component, Focusable {
	focused = false;
	private readonly snapshotProvider: () => TuiStatusSnapshot;
	private readonly rowsProvider: () => number;
	private readonly actions: TuiStatusOverlayActions;
	private offset = 0;
	private maxOffset = 0;
	private bodyRows = 1;

	constructor(
		snapshot: TuiStatusSnapshot | (() => TuiStatusSnapshot),
		rowsProvider: () => number,
		actions: TuiStatusOverlayActions,
	) {
		this.snapshotProvider = typeof snapshot === "function" ? snapshot : () => snapshot;
		this.rowsProvider = rowsProvider;
		this.actions = actions;
	}

	render(width: number): string[] {
		const snapshot = this.snapshotProvider();
		const columns = Math.max(1, Math.min(MAX_OVERLAY_COLUMNS, Math.floor(width)));
		const maxRows = Math.max(1, Math.floor(this.rowsProvider()));
		const project = clean(snapshot.projectPath);
		const provider = clean(snapshot.provider);
		const model = clean(snapshot.model);
		const reasoning = clean(snapshot.reasoning);
		const phase = clean(snapshot.phase);
		const session = clean(snapshot.sessionId);
		const context = contextLabel(snapshot);
		const responseSource = clean(snapshot.latestResponse?.source);
		const responseTitle = responseSource === UNKNOWN ? "Latest response" : `Latest response · ${responseSource}`;
		const work = [
			count(snapshot.activeCount, `active request${snapshot.activeCount === 1 ? "" : "s"}`) ??
				`${UNKNOWN} active requests`,
			count(snapshot.pendingCount, `pending request${snapshot.pendingCount === 1 ? "" : "s"}`) ??
				`${UNKNOWN} pending requests`,
			count(snapshot.changedFileCount, "changed"),
		].filter((value): value is string => value !== undefined);
		const execution = snapshot.execution
			? formatExecutionGraphLines(snapshot.execution, columns)
			: [field("Execution", "No recorded work")];
		const body = [
			field("Project", project),
			...(snapshot.goal ? [field("Goal", clean(snapshot.goal))] : []),
			`${field("Provider", provider)}  ${field("Model", model)}`,
			`${field("Reasoning", reasoning)}  ${field("Phase", phase)}`,
			`${field("Session", session)}  ${field("Context", context)}`,
			field("Work", work.join(" · ")),
			...execution,
			field(responseTitle, latestResponseLabel(snapshot.latestResponse)),
			field("Prompt cache", cacheWarmStatusLabel(snapshot.cacheWarm)),
		];
		const title = frameLine(`${accent("Status")}  ${muted("read only · ↑↓/PgUp/PgDn · Esc/q close")}`, columns);
		if (maxRows === 1) return [title];
		this.bodyRows = Math.max(0, maxRows - 2);
		this.maxOffset = Math.max(0, body.length - this.bodyRows);
		this.offset = Math.min(this.offset, this.maxOffset);
		const visible = body.slice(this.offset, this.offset + this.bodyRows);
		const start = body.length === 0 ? 0 : this.offset + 1;
		const end = Math.min(body.length, this.offset + visible.length);
		const footer = frameLine(muted(`${start}-${end}/${body.length} rows · live snapshot`), columns);
		return [title, ...visible.map((line) => frameLine(ellipsizeCells(line, columns), columns)), footer].slice(
			0,
			maxRows,
		);
	}

	handleInput(data: string): void {
		if (data.toLowerCase() === "q" || matchesKey(data, "escape")) {
			this.actions.close();
			return;
		}
		const page = Math.max(1, this.bodyRows);
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset = Math.min(this.maxOffset, this.offset + 1);
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "pageDown")) this.offset = Math.min(this.maxOffset, this.offset + page);
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = this.maxOffset;
		else return;
		this.actions.invalidate();
	}

	invalidate(): void {}
}

export { TuiStatusOverlay as StatusOverlay };
export type StatusLatestResponseMetrics = TuiLatestResponseMetrics;
export type StatusOverlayActions = TuiStatusOverlayActions;
export type StatusOverlaySnapshot = TuiStatusSnapshot;
