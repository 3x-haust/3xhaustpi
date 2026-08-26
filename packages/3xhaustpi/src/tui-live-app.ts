import { quarantineInvalidAgentConversationHead } from "./agent-session-catalog.ts";
import { approvalFitsTerminal } from "./tui-approval.ts";
import {
	bindTuiSigint,
	formatHelpCommandLines,
	resolveTuiInputAction,
	shouldDeferTuiInputToImageViewer,
} from "./tui-command-helpers.ts";
import type { RunTuiInput } from "./tui-contract.ts";
import { TuiImageViewer } from "./tui-image-viewer.ts";
import { createTuiAutocompleteController } from "./tui-live-autocomplete.ts";
import { createTuiDesktopController } from "./tui-live-desktop.ts";
import { createTuiTaskEvents } from "./tui-live-events.ts";
import { createTuiLiveCore } from "./tui-live-state.ts";
import { installTuiSubmission } from "./tui-live-submit.ts";
import { createTuiTaskController } from "./tui-live-tasks.ts";
import { createTuiLiveView } from "./tui-live-view.ts";
import { createTuiWorkspaceCommands } from "./tui-live-workspace.ts";
import { enableTuiMouseTracking, parseTuiMouseInput } from "./tui-mouse.ts";
import { muted, success, warning } from "./tui-text.ts";

export async function runTui(input: RunTuiInput): Promise<void> {
	const core = createTuiLiveCore(input);
	const { state } = core;
	const imageViewer = new TuiImageViewer(core.ui);
	const quarantinedSessionId = await quarantineInvalidAgentConversationHead(state.projectRoot, core.database);
	if (quarantinedSessionId) state.agentSessionIds.delete(state.projectRoot);
	const view = createTuiLiveView(core);
	core.composer.onError = (error) => view.appendText(warning(`Could not attach clipboard image: ${error.message}`));
	core.composer.onOpenImage = (image) => imageViewer.open(image);
	core.transcript.onOpenImage = (image) => imageViewer.open(image);
	core.composer.onRenderRequested = () => core.ui.requestRender();
	if (quarantinedSessionId) {
		view.appendText(warning(`Ignored invalid saved session ${quarantinedSessionId}.`));
	}
	const events = createTuiTaskEvents(core, view);
	const tasks = createTuiTaskController(core, view, events);
	const workspace = createTuiWorkspaceCommands(core, view);
	const desktop = createTuiDesktopController(core, view);
	const autocomplete = createTuiAutocompleteController(core, workspace);
	let disableMouseTracking: (() => void) | undefined;
	const requestExit = () => {
		disableMouseTracking?.();
		state.active = false;
		state.activeController?.abort();
		state.desktopController?.abort();
		if (state.approvalResolve) {
			const resolve = state.approvalResolve;
			state.approvalResolve = undefined;
			state.approvalKind = undefined;
			state.approvalToolName = undefined;
			state.approvalReviewText = undefined;
			resolve(false);
		}
		core.ui.stop();
		process.exitCode = 0;
		if (!state.activeExecution && !state.desktopOperation) core.finish();
	};
	autocomplete.installAutocomplete();
	installTuiSubmission({ core, view, tasks, workspace, desktop, autocomplete, requestExit });
	core.ui.addInputListener((value) => {
		const imageViewerOpen = imageViewer.isOpen();
		const action = resolveTuiInputAction(value, {
			approvalPending: state.approvalResolve !== undefined,
			approvalReviewable: approvalFitsTerminal(
				state.approvalReviewText,
				process.stdout.columns || 120,
				process.stdout.rows || 36,
			),
			active: state.activeController !== undefined || state.desktopController !== undefined,
			composerText: core.editor.getText(),
			pendingCount: state.queuedRequests.length,
			overlayOpen: core.ui.hasOverlay(),
		});
		if (shouldDeferTuiInputToImageViewer(imageViewerOpen, action)) return undefined;
		if (imageViewerOpen) imageViewer.close();
		const mouse = parseTuiMouseInput(value);
		if (mouse) {
			if (!core.ui.hasOverlay() && !core.composer.handleMouseInput(value)) {
				core.transcript.handleMouseInput(value);
			}
			return { consume: true };
		}
		if (action === "pass") return undefined;
		if (action === "pass-approval-input") return undefined;
		if (action === "clear-input") {
			core.editor.setText("");
			core.composer.clearAttachments();
			view.updateChrome();
			return { consume: true };
		}
		if (action === "open-history") {
			view.openHistory();
			return { consume: true };
		}
		if (action === "open-help") {
			view.appendText(formatHelpCommandLines(process.stdout.columns || 120).join("\n"));
			return { consume: true };
		}
		if (action === "recall-pending") {
			const recalled = core.database.recallNewestQueuedTuiRequest(state.projectRoot);
			if (recalled) {
				core.composer.restoreDraft(recalled.objective, recalled.images ?? []);
				view.followTranscript();
				view.appendText(muted("Recalled newest pending input for editing."));
			}
			view.refreshQueue();
			return { consume: true };
		}
		if (action === "exit") {
			requestExit();
			return { consume: true };
		}
		if (action === "interrupt") {
			state.canceledActive = true;
			state.activeController?.abort();
			state.desktopController?.abort();
			view.updateChrome("");
			return { consume: true };
		}
		if (action === "approve-approval" || action === "reject-approval") {
			const resolve = state.approvalResolve;
			const kind = state.approvalKind;
			const toolName = state.approvalToolName;
			state.approvalResolve = undefined;
			state.approvalKind = undefined;
			state.approvalToolName = undefined;
			state.approvalReviewText = undefined;
			const approved = action === "approve-approval";
			state.phase = kind === "tool" || approved ? "running" : "ready";
			if (kind === "patch") view.appendText(approved ? success("✓ Patch approved") : warning("Patch rejected"));
			else if (kind === "tool")
				view.appendText(
					approved ? success(`✓ ${toolName ?? "Tool"} approved`) : warning(`${toolName ?? "Tool"} rejected`),
				);
			else if (approved) view.appendText(success("✓ Computer action approved"));
			view.updateChrome("");
			resolve?.(approved);
		}
		return { consume: true };
	});
	core.ui.setFocus(core.editor);
	const unbindSigint = bindTuiSigint(process, requestExit);
	try {
		core.ui.start();
		disableMouseTracking = enableTuiMouseTracking(core.ui.terminal);
		tasks.drainQueue();
		await core.closed;
	} finally {
		disableMouseTracking?.();
		imageViewer.close();
		unbindSigint();
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		await core.cacheWarm.close();
		core.database.close();
	}
}
