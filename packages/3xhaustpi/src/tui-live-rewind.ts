import {
	type AgentConversationRewindPoint,
	forkAgentConversationAtUserTurn,
	listAgentConversationRewindPoints,
	listAgentConversationSessions,
} from "./agent-session-catalog.ts";
import type { TuiAutocompleteController } from "./tui-live-autocomplete.ts";
import { resetLiveContextTelemetry, type TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { RewindOverlay } from "./tui-rewind-overlay.ts";
import { failure, warning } from "./tui-text.ts";

export async function startRewind(
	core: TuiLiveCore,
	view: TuiLiveView,
	autocomplete: TuiAutocompleteController,
): Promise<void> {
	if (core.state.activeExecution || core.state.queuedRequests.length > 0) {
		view.appendText(warning("Finish active and pending work before rewinding."));
		return;
	}
	const head = core.database.readTuiConversationHead(core.state.projectRoot);
	if (!head.sessionId) {
		view.appendText(warning("No active conversation to rewind."));
		return;
	}
	const points = await listAgentConversationRewindPoints(core.state.projectRoot, head.sessionId);
	if (points.length === 0) {
		view.appendText(warning("No conversation turns are available to rewind."));
		return;
	}
	let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
	const select = (point: AgentConversationRewindPoint) => {
		void (async () => {
			try {
				const fork = await forkAgentConversationAtUserTurn(
					core.state.projectRoot,
					head.sessionId ?? "",
					point.entryId,
				);
				const current = core.database.readTuiConversationHead(core.state.projectRoot);
				core.database.compareAndSwapTuiConversationHead(core.state.projectRoot, {
					expectedGeneration: current.generation,
					sessionId: fork.sessionId,
				});
				if (fork.sessionId) core.state.agentSessionIds.set(core.state.projectRoot, fork.sessionId);
				else core.state.agentSessionIds.delete(core.state.projectRoot);
				resetLiveContextTelemetry(core.state);
				core.cacheWarm.setTarget(undefined);
				if (fork.model) {
					core.state.provider = fork.model.provider;
					core.state.model = fork.model.modelId;
				}
				core.state.thinkingLevel = fork.thinkingLevel;
				view.replaceConversation(fork.messages);
				core.editor.setText(fork.selectedPrompt);
				core.state.conversationSessions = await listAgentConversationSessions(core.state.projectRoot);
				autocomplete.installAutocomplete();
				view.updateChrome("conversation branch");
				handle?.hide();
			} catch (cause) {
				handle?.hide();
				view.appendText(failure(cause instanceof Error ? cause.message : String(cause)));
			}
		})();
	};
	const overlay = new RewindOverlay(points, () => Math.max(3, Math.floor((process.stdout.rows || 36) * 0.4)), {
		select,
		close: () => handle?.hide(),
	});
	handle = core.ui.showOverlay(overlay, {
		width: Math.max(36, Math.min(76, (process.stdout.columns || 120) - 4)),
		maxHeight: "40%",
		anchor: "top-center",
		margin: 2,
	});
}
