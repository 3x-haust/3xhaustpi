import { loadAgentConversation } from "./agent-session-catalog.ts";
import { compactContextTokens, contextUsageLabel } from "./tui-context-meter.ts";
import { liveContextLimit, resetLiveContextTelemetry, type TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { ReadonlyOutputOverlay } from "./tui-readonly-output-overlay.ts";
import { failure, success, warning } from "./tui-text.ts";

export async function startCompaction(instructions: string, core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	const compact = core.input.compactConversation;
	if (!compact) {
		view.appendText(warning("Conversation compaction is unavailable."));
		return;
	}
	if (core.state.activeExecution || core.state.queuedRequests.length > 0) {
		view.appendText(warning("Finish active and pending work before compacting."));
		return;
	}
	const head = core.database.readTuiConversationHead(core.state.projectRoot);
	if (!head.sessionId) {
		view.appendText(warning("No active conversation to compact."));
		return;
	}
	const accountId = core.database.findTuiProviderAccount(core.state.projectRoot, core.state.provider);
	const controller = new AbortController();
	core.state.activeController = controller;
	core.cacheWarm.suspend();
	const startedAt = performance.now();
	view.updateChrome("compacting…");
	try {
		const result = await compact({
			projectRoot: core.state.projectRoot,
			sessionId: head.sessionId,
			...(instructions ? { instructions } : {}),
			provider: core.state.provider,
			model: core.state.model,
			...(accountId ? { accountId } : {}),
			thinkingLevel: core.state.thinkingLevel,
			signal: controller.signal,
		});
		const durationSeconds = (performance.now() - startedAt) / 1_000;
		resetLiveContextTelemetry(core.state);
		const reduction =
			result.estimatedTokensAfter === undefined || result.tokensBefore <= 0
				? `${compactContextTokens(result.tokensBefore)} tokens before`
				: `est. ${compactContextTokens(result.tokensBefore)} → ${compactContextTokens(result.estimatedTokensAfter)} tokens (${(
						(1 - result.estimatedTokensAfter / result.tokensBefore) * 100
					).toFixed(1)}% less)`;
		view.appendText(success(`✓ Context compacted · ${reduction} · ${durationSeconds.toFixed(1)}s`));
		try {
			const conversation = await loadAgentConversation(core.state.projectRoot, head.sessionId);
			view.replaceConversation(conversation.messages);
		} catch (cause) {
			view.appendText(
				warning(`Compacted, but transcript refresh failed: ${cause instanceof Error ? cause.message : cause}`),
			);
		}
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		const context = contextUsageLabel(core.state.latestContextTokens, liveContextLimit(core), "feedback");
		view.appendText(
			failure(message.startsWith("Nothing to compact") && context ? `${message} · ${context}` : message),
		);
	} finally {
		if (core.state.activeController === controller) core.state.activeController = undefined;
		core.cacheWarm.resume();
		view.updateChrome("");
	}
}

export async function startWorkingTreeReview(focus: string, core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	const review = core.input.reviewWorkingTree;
	if (!review) {
		view.appendText(warning("Working-tree review is unavailable."));
		return;
	}
	if (core.state.activeExecution || core.state.queuedRequests.length > 0) {
		view.appendText(warning("Finish active and pending work before reviewing."));
		return;
	}
	const controller = new AbortController();
	let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
	const overlay = new ReadonlyOutputOverlay("Review", () => process.stdout.rows || 36, {
		close: () => handle?.hide(),
		invalidate: () => core.ui.requestRender(),
		cancel: () => controller.abort(new Error("Review cancelled")),
	});
	handle = core.ui.showOverlay(overlay, {
		width: Math.max(36, Math.min(76, (process.stdout.columns || 120) - 4)),
		maxHeight: "40%",
		anchor: "top-center",
		margin: 2,
	});
	const accountId = core.database.findTuiProviderAccount(core.state.projectRoot, core.state.provider);
	try {
		const answer = await review({
			projectRoot: core.state.projectRoot,
			...(focus ? { focus } : {}),
			provider: core.state.provider,
			model: core.state.model,
			...(accountId ? { accountId } : {}),
			thinkingLevel: core.state.thinkingLevel,
			signal: controller.signal,
		});
		overlay.setText(answer);
		overlay.setState("complete");
	} catch (cause) {
		if (controller.signal.aborted) return;
		overlay.setText(cause instanceof Error ? cause.message : String(cause));
		overlay.setState("failure");
	}
}
