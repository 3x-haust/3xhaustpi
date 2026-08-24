import { quarantineInvalidAgentConversationHead } from "./agent-session-catalog.ts";
import { approvalFitsTerminal } from "./tui-approval.ts";
import { bindTuiSigint, formatHelpCommandLines, resolveTuiInputAction } from "./tui-command-helpers.ts";
import type { RunTuiInput } from "./tui-contract.ts";
import { createTuiAutocompleteController } from "./tui-live-autocomplete.ts";
import { createTuiDesktopController } from "./tui-live-desktop.ts";
import { createTuiTaskEvents } from "./tui-live-events.ts";
import { createTuiLiveCore } from "./tui-live-state.ts";
import { installTuiSubmission } from "./tui-live-submit.ts";
import { createTuiTaskController } from "./tui-live-tasks.ts";
import { createTuiLiveView } from "./tui-live-view.ts";
import { createTuiWorkspaceCommands } from "./tui-live-workspace.ts";
import { success, warning } from "./tui-text.ts";

export async function runTui(input: RunTuiInput): Promise<void> {
	const core = createTuiLiveCore(input);
	const { state } = core;
	const quarantinedSessionId = await quarantineInvalidAgentConversationHead(state.projectRoot, core.database);
	if (quarantinedSessionId) state.agentSessionIds.delete(state.projectRoot);
	const view = createTuiLiveView(core);
	if (quarantinedSessionId) {
		view.appendText(warning(`Ignored invalid saved session ${quarantinedSessionId}.`));
	}
	const events = createTuiTaskEvents(core, view);
	const tasks = createTuiTaskController(core, view, events);
	const workspace = createTuiWorkspaceCommands(core, view);
	const desktop = createTuiDesktopController(core, view);
	const autocomplete = createTuiAutocompleteController(core, workspace);
	const requestExit = () => {
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
		const action = resolveTuiInputAction(value, {
			approvalPending: state.approvalResolve !== undefined,
			approvalReviewable: approvalFitsTerminal(
				state.approvalReviewText,
				process.stdout.columns || 120,
				process.stdout.rows || 36,
			),
			active: state.activeController !== undefined || state.desktopController !== undefined,
			composerText: core.editor.getText(),
		});
		if (action === "pass") return undefined;
		if (action === "pass-approval-input") return undefined;
		if (action === "clear-input") {
			core.editor.setText("");
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
		tasks.drainQueue();
		await core.closed;
	} finally {
		unbindSigint();
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	}
}
