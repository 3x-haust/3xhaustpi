import { basename } from "node:path";
import { listAgentConversationSessions, loadAgentConversation } from "./agent-session-catalog.ts";
import { parseTuiCommand, resolveModelSelection } from "./tui-command-helpers.ts";
import { formatExecutionGraphLines } from "./tui-execution-view.ts";
import { startAccountCommand, startAccountManager } from "./tui-live-account.ts";
import type { TuiAutocompleteController } from "./tui-live-autocomplete.ts";
import type { TuiAuxiliaryController } from "./tui-live-auxiliary.ts";
import { handleTuiQuickCommand } from "./tui-live-command-dispatch.ts";
import type { TuiDesktopController } from "./tui-live-desktop.ts";
import { admitTuiMainTurn } from "./tui-live-main-queue.ts";
import {
	handleMcpCommand,
	handleSkillCommand,
	startResourcesCommand,
	startSkillBrowser,
} from "./tui-live-resources.ts";
import { handleTuiSessionCommand } from "./tui-live-session-commands.ts";
import { startSettings } from "./tui-live-settings.ts";
import { resetLiveContextTelemetry, type TuiLiveCore } from "./tui-live-state.ts";
import type { TuiTaskController } from "./tui-live-tasks.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import type { TuiWorkspaceCommands } from "./tui-live-workspace.ts";
import { dim, failure, muted, success, text, warning } from "./tui-text.ts";

interface SubmitDependencies {
	readonly core: TuiLiveCore;
	readonly view: TuiLiveView;
	readonly tasks: TuiTaskController;
	readonly workspace: TuiWorkspaceCommands;
	readonly desktop: TuiDesktopController;
	readonly autocomplete: TuiAutocompleteController;
	readonly auxiliary?: TuiAuxiliaryController;
	readonly requestExit: () => void;
}

export function installTuiSubmission(deps: SubmitDependencies): void {
	const { core, view, tasks, workspace, desktop, autocomplete, auxiliary, requestExit } = deps;
	const { state, database, composer, editor } = core;
	const refreshConversationSessions = async () => {
		state.conversationSessions = await listAgentConversationSessions(state.projectRoot);
		autocomplete.installAutocomplete();
		return state.conversationSessions;
	};
	editor.onSubmit = async (value) => {
		const objective = value.trim();
		if (!objective) return;
		try {
			const displayImages = composer.displayImagesFor(objective);
			const images = displayImages.map(({ data, mimeType }) => ({ data, mimeType }));
			view.followTranscript();
			editor.addToHistory(objective);
			editor.setText("");
			const parsedCommand = parseTuiCommand(objective);
			if (parsedCommand) {
				composer.clearAttachments();
				const { name: command, argument } = parsedCommand;
				if (command === "exit") {
					view.appendText(muted("Exiting."));
					requestExit();
					return;
				}
				if (command === "model") {
					if (!argument) {
						await startSettings(core, view, autocomplete, desktop, "model");
						return;
					}
					const selection = resolveModelSelection(await autocomplete.currentProviderModels(), argument);
					if (!selection.ok) {
						view.appendText(warning(selection.message));
						return;
					}
					state.model = selection.model;
					resetLiveContextTelemetry(state);
					view.updateChrome(`model ${state.model}`);
					autocomplete.installAutocomplete();
					view.appendText(`${success("✓")} model ${text(state.model)}`);
					return;
				}
				if (command === "provider") {
					const providerModels = (await autocomplete.eligibleProviderModels()).filter(
						({ provider }) => provider === argument,
					);
					if (providerModels.length === 0) {
						view.appendText(warning(`No enabled logged-in account for provider ${argument || "(empty)"}.`));
						return;
					}
					state.provider = argument;
					if (!providerModels.some(({ model }) => model === state.model)) {
						state.model = providerModels[0]?.model ?? state.model;
					}
					resetLiveContextTelemetry(state);
					autocomplete.installAutocomplete();
					view.updateChrome(`provider ${state.provider}`);
					return;
				}
				if (command === "thinking") {
					const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
					const level = levels.find((candidate) => candidate === argument);
					if (!level) {
						view.appendText(warning(`Thinking must be one of: ${levels.join(", ")}`));
						return;
					}
					state.thinkingLevel = level;
					view.updateChrome(`thinking ${level}`);
					return;
				}
				if (await handleTuiQuickCommand(command, argument, { core, view, autocomplete, desktop, auxiliary }))
					return;
				if (command === "account") {
					if (argument) startAccountCommand(argument, core, view);
					else startAccountManager(core, view);
					return;
				}
				if (command === "resources") {
					startResourcesCommand(core, view);
					return;
				}
				if (command === "skills") {
					startSkillBrowser(core, view);
					return;
				}
				if (command === "skill") {
					await handleSkillCommand(argument, core, view);
					return;
				}
				if (command === "mcp") {
					await handleMcpCommand(argument, core, view);
					return;
				}
				if (command === "computer") {
					desktop.startComputerCommand(argument);
					return;
				}
				if (command === "projects" || (command === "project" && !argument)) {
					workspace.showProjects();
					return;
				}
				if (command === "project") {
					if (
						state.mainAdmissions > 0 ||
						state.activeExecution ||
						auxiliary?.isRunning() ||
						state.queuedRequests.length > 0
					) {
						view.appendText(warning("Finish active and pending work before switching projects."));
						return;
					}
					const project = workspace.resolveProject(argument);
					if (!project) {
						view.appendText(warning(`Project not found or ambiguous: ${argument}`));
						return;
					}
					state.projectRoot = project.path;
					resetLiveContextTelemetry(state);
					state.projectGoal = database.findTuiProjectGoal(state.projectRoot);
					core.cacheWarm.reset(
						core.input.warmCache !== undefined &&
							database.findTuiProjectPreference(state.projectRoot, "cache-warm") === "eligible",
					);
					const head = database.readTuiConversationHead(state.projectRoot);
					if (head.sessionId) state.agentSessionIds.set(state.projectRoot, head.sessionId);
					else state.agentSessionIds.delete(state.projectRoot);
					view.refreshWorkspace();
					view.refreshQueue();
					await refreshConversationSessions();
					if (head.sessionId) {
						const conversation = await loadAgentConversation(state.projectRoot, head.sessionId);
						view.replaceConversation(conversation.messages);
						if (conversation.model) {
							state.provider = conversation.model.provider;
							state.model = conversation.model.modelId;
						}
						state.thinkingLevel = conversation.thinkingLevel;
					} else {
						view.replaceConversation([]);
					}
					view.updateHeader();
					autocomplete.installAutocomplete();
					view.appendText(`${success("●")} Switched to ${text(basename(state.projectRoot))}`);
					return;
				}
				if (await handleTuiSessionCommand(command, argument, { core, view, tasks, autocomplete })) return;
				if (command === "history") {
					view.openHistory();
					return;
				}
				if (command === "agents") {
					const projections = database.listTuiExecutionGraphs(state.projectRoot);
					const requested = argument ? Number.parseInt(argument, 10) : 1;
					const projection =
						Number.isSafeInteger(requested) && requested >= 1 && String(requested) === (argument || "1")
							? projections[requested - 1]
							: undefined;
					if (!projection) {
						view.appendText(
							projections.length === 0 ? dim("No durable work graphs.") : warning("Usage: /agents [n]"),
						);
						return;
					}
					for (const line of formatExecutionGraphLines(projection, process.stdout.columns || 120))
						view.appendText(line);
					return;
				}
				view.appendText(warning(`Unknown command: /${command}. Type /help.`));
				return;
			}
			const admission = await admitTuiMainTurn(core, { objective, ...(images.length ? { images } : {}) });
			if (admission.status === "account-unavailable") {
				editor.setText(objective);
				view.appendText(
					warning(`No selected account for ${admission.provider}. Open /account to connect or enable one.`),
				);
				return;
			}
			composer.clearAttachments();
			view.refreshQueue();
			view.appendUser(objective, admission.inserted, displayImages);
			if (!admission.inserted)
				view.appendText(warning(`already queued ${admission.request.position}  ${objective}`));
			tasks.drainQueue();
		} catch (error) {
			editor.setText(objective);
			view.appendText(failure(`Error: ${error instanceof Error ? error.message : String(error)}`));
		}
	};
}
