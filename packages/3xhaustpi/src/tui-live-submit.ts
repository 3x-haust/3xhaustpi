import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { eligibleModelAccounts, resolveSessionAccount } from "./account-selection.ts";
import { listAgentConversationSessions, loadAgentConversation } from "./agent-session-catalog.ts";
import { collectProviderConnections } from "./connections.ts";
import { createProviderRuntime } from "./provider-runtime.ts";
import { parseTuiCommand, resolveModelSelection } from "./tui-command-helpers.ts";
import { formatExecutionGraphLines } from "./tui-execution-view.ts";
import { startAccountCommand, startAccountManager } from "./tui-live-account.ts";
import type { TuiAutocompleteController } from "./tui-live-autocomplete.ts";
import { handleTuiQuickCommand } from "./tui-live-command-dispatch.ts";
import type { TuiDesktopController } from "./tui-live-desktop.ts";
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
import { dim, muted, success, text, warning } from "./tui-text.ts";

interface SubmitDependencies {
	readonly core: TuiLiveCore;
	readonly view: TuiLiveView;
	readonly tasks: TuiTaskController;
	readonly workspace: TuiWorkspaceCommands;
	readonly desktop: TuiDesktopController;
	readonly autocomplete: TuiAutocompleteController;
	readonly requestExit: () => void;
}

export function installTuiSubmission(deps: SubmitDependencies): void {
	const { core, view, tasks, workspace, desktop, autocomplete, requestExit } = deps;
	const { state, database, composer, editor } = core;
	const refreshConversationSessions = async () => {
		state.conversationSessions = await listAgentConversationSessions(state.projectRoot);
		autocomplete.installAutocomplete();
		return state.conversationSessions;
	};
	editor.onSubmit = async (value) => {
		const objective = value.trim();
		if (!objective) return;
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
					startSettings(core, view, autocomplete, desktop, "model");
					return;
				}
				const selection = resolveModelSelection(autocomplete.currentProviderModels(), argument);
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
				const providers = createProviderRuntime().getProviders();
				const provider = providers.find(({ id }) => id === argument);
				if (!provider) {
					view.appendText(warning(`Unknown provider: ${argument || "(empty)"}`));
					return;
				}
				state.provider = provider.id;
				if (!provider.getModels().some(({ id }) => id === state.model)) {
					state.model = provider.getModels()[0]?.id ?? state.model;
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
			if (await handleTuiQuickCommand(command, argument, { core, view, autocomplete, desktop })) return;
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
				if (state.activeExecution || state.queuedRequests.length > 0) {
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
		const conversation = database.readTuiConversationHead(state.projectRoot);
		const accounts = (await collectProviderConnections()).flatMap(({ accounts }) => accounts);
		const exclusions = database.listTuiAccountExclusions(state.projectRoot);
		const pinnedAccountId = database.findTuiProviderAccount(state.projectRoot, state.provider);
		const account =
			eligibleModelAccounts(accounts, exclusions).find(
				(candidate) => candidate.providerId === state.provider && candidate.id === pinnedAccountId,
			) ??
			resolveSessionAccount(
				accounts,
				exclusions,
				state.provider,
				conversation.sessionId ?? `${state.projectRoot}:${conversation.generation}`,
			);
		if (!account) {
			editor.setText(objective);
			view.appendText(warning(`No selected account for ${state.provider}. Open /account to connect or enable one.`));
			return;
		}
		if (account.id !== pinnedAccountId) {
			database.setTuiProviderAccount(state.projectRoot, state.provider, account.id);
		}
		const binding = {
			version: 1 as const,
			conversationGeneration: conversation.generation,
			sessionId: conversation.sessionId,
			provider: state.provider,
			model: state.model,
			accountId: account.id,
			thinkingLevel: state.thinkingLevel,
		};
		const fingerprint = createHash("sha256")
			.update(`${state.projectRoot}\0${binding.conversationGeneration}\0${binding.sessionId ?? ""}\0`)
			.update(`${binding.provider}\0${binding.model}\0${binding.accountId}\0${objective}`)
			.update("\0");
		for (const image of images) fingerprint.update(image.mimeType).update("\0").update(image.data).update("\0");
		const enqueued = database.enqueueTuiRequest({
			requestId: `tui_${randomUUID()}`,
			projectPath: state.projectRoot,
			fingerprint: fingerprint.digest("hex"),
			objective,
			...(images.length ? { images } : {}),
			binding,
		});
		composer.clearAttachments();
		view.refreshQueue();
		view.appendUser(objective, enqueued.inserted, displayImages);
		if (!enqueued.inserted) view.appendText(warning(`already queued ${enqueued.request.position}  ${objective}`));
		tasks.drainQueue();
	};
}
