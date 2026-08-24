import { basename } from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { createProviderRuntime } from "./provider-runtime.ts";
import { orderModelsForPicker } from "./tui-command-helpers.ts";
import { terminalBelowFloor } from "./tui-layout-frame.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiWorkspaceCommands } from "./tui-live-workspace.ts";

export interface TuiAutocompleteController {
	currentProviderModels(): ReturnType<ReturnType<typeof createProviderRuntime>["getModels"]>;
	installAutocomplete(): void;
}

export function createTuiAutocompleteController(
	core: TuiLiveCore,
	workspace: TuiWorkspaceCommands,
): TuiAutocompleteController {
	const { state } = core;
	const currentProviderModels = () => createProviderRuntime().getModels(state.provider);
	const installAutocomplete = () => {
		const commands: SlashCommand[] = [
			{ name: "new", description: "Start a new chat" },
			{
				name: "model",
				argumentHint: "[id]",
				description: "List or select current-provider models",
				getArgumentCompletions: () =>
					orderModelsForPicker(currentProviderModels(), state.model).map((candidate) => ({
						value: candidate.id,
						label: candidate.id,
						description: candidate.id === state.model ? "current" : state.provider,
					})),
			},
			{
				name: "provider",
				argumentHint: "<id>",
				description: "Select a model provider",
				getArgumentCompletions: () =>
					createProviderRuntime()
						.getProviders()
						.map((provider) => ({
							value: provider.id,
							label: provider.name,
							description: provider.id === state.provider ? "current" : `${provider.getModels().length} models`,
						})),
			},
			{
				name: "thinking",
				argumentHint: "<level>",
				description: "Select reasoning effort",
				getArgumentCompletions: () =>
					["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => ({
						value: level,
						label: level,
						description: level === state.thinkingLevel ? "current" : "reasoning effort",
					})),
			},
			{ name: "exit", description: "Abort active work and quit" },
			{ name: "projects", description: "List known projects" },
			{
				name: "project",
				argumentHint: "<project>",
				description: "Switch project",
				getArgumentCompletions: () =>
					workspace.projectEntries().map((project, index) => ({
						value: String(index + 1),
						label: `${index + 1}  ${basename(project.path)}`,
						description: `${project.chatCount} chats`,
					})),
			},
			{ name: "sessions", description: "List saved conversations in this project" },
			{ name: "chats", description: "Alias for /sessions" },
			{
				name: "chat",
				argumentHint: "<session>",
				description: "Alias for /resume",
				getArgumentCompletions: () =>
					state.conversationSessions.map((session, index) => ({
						value: String(index + 1),
						label: `${index + 1}  ${session.name ?? session.firstPrompt}`,
						description: `${session.messageCount} messages · ${session.id.slice(-8)}`,
					})),
			},
			{
				name: "resume",
				argumentHint: "[session]",
				description: "Open or select a saved conversation",
				getArgumentCompletions: () =>
					state.conversationSessions.map((session, index) => ({
						value: String(index + 1),
						label: `${index + 1}  ${session.name ?? session.firstPrompt}`,
						description: `${session.messageCount} messages · ${session.id.slice(-8)}`,
					})),
			},
			{ name: "recover", argumentHint: "[checkpoint]", description: "Recover interrupted execution" },
			{ name: "history", description: "Open the full conversation viewer" },
			{ name: "agents", argumentHint: "[n]", description: "Inspect a durable work graph" },
			{ name: "accounts", argumentHint: "[use <id>]", description: "Show and select connected accounts" },
			{ name: "resources", description: "Show Skills, MCP servers, and Hooks" },
			{ name: "skill", argumentHint: "create <name>", description: "Create a project skill template" },
			{
				name: "mcp",
				argumentHint: "add <name> <command> [args...] | tools <server> | call <server> <tool> [json]",
				description: "Use MCP servers",
			},
			{
				name: "computer",
				argumentHint: "[apps | observe <app> | click <element>]",
				description: "Observe or run a reviewed semantic desktop action",
			},
			{ name: "clear", description: "Clear the visible transcript" },
			{ name: "help", description: "Show TUI commands" },
		];
		const provider = new CombinedAutocompleteProvider(commands, state.projectRoot);
		const floorAwareProvider: AutocompleteProvider = {
			getSuggestions: (lines, cursorLine, cursorCol, options) =>
				state.terminalBelowFloor || terminalBelowFloor(process.stdout.columns || 120, process.stdout.rows || 36)
					? Promise.resolve(null)
					: provider.getSuggestions(lines, cursorLine, cursorCol, options),
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
				provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
				!state.terminalBelowFloor &&
				!terminalBelowFloor(process.stdout.columns || 120, process.stdout.rows || 36) &&
				Boolean(provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol)),
		};
		core.editor.setAutocompleteProvider(floorAwareProvider);
	};
	return { currentProviderModels, installAutocomplete };
}
