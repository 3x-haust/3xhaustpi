import { liveContextLimit, type TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { TuiStatusOverlay, type TuiStatusSnapshot } from "./tui-status-overlay.ts";

export function buildTuiStatusSnapshot(core: TuiLiveCore, view: TuiLiveView): TuiStatusSnapshot {
	const head = core.database.readTuiConversationHead(core.state.projectRoot);
	const outputTokens = core.state.responseOutputTokens > 0 ? core.state.responseOutputTokens : undefined;
	const durationMs = core.state.responseDurationMs > 0 ? core.state.responseDurationMs : undefined;
	const execution = core.database.listTuiExecutionGraphs(core.state.projectRoot)[0];
	return {
		projectPath: core.state.projectRoot,
		provider: core.state.provider,
		model: core.state.model,
		reasoning: core.state.thinkingLevel,
		phase: core.state.phase,
		...(head.sessionId ? { sessionId: head.sessionId } : {}),
		...(core.state.latestContextTokens !== undefined ? { contextTokens: core.state.latestContextTokens } : {}),
		...(liveContextLimit(core) !== undefined ? { contextLimit: liveContextLimit(core) } : {}),
		cacheWarm: core.cacheWarm.snapshot(),
		...(core.state.projectGoal?.status === "active" ? { goal: core.state.projectGoal.text } : {}),
		...(execution ? { execution } : {}),
		...(outputTokens !== undefined || durationMs !== undefined || core.state.latestCacheHitRatio !== undefined
			? {
					latestResponse: {
						source: "provider turn",
						...(outputTokens !== undefined ? { outputTokens } : {}),
						...(durationMs !== undefined ? { durationMs } : {}),
						...(core.state.latestCacheHitRatio !== undefined
							? { cacheHitPercent: core.state.latestCacheHitRatio * 100 }
							: {}),
					},
				}
			: {}),
		activeCount: view.activeTaskCount(),
		pendingCount: core.state.queuedRequests.length,
	};
}

export function startStatus(core: TuiLiveCore, view: TuiLiveView): void {
	let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
	const overlay = new TuiStatusOverlay(
		() => buildTuiStatusSnapshot(core, view),
		() => Math.max(1, Math.floor((process.stdout.rows || 36) * 0.4)),
		{
			close: () => handle?.hide(),
			invalidate: () => core.ui.requestRender(),
		},
	);
	handle = core.ui.showOverlay(overlay, {
		width: Math.max(36, Math.min(76, (process.stdout.columns || 120) - 4)),
		maxHeight: "40%",
		anchor: "top-center",
		margin: 2,
	});
}
