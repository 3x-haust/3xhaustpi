import { basename } from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { createProviderRuntime } from "./provider-runtime.ts";
import { TUI_PRIMARY_COMMANDS } from "./tui-command-catalog.ts";
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
		const commands: SlashCommand[] = TUI_PRIMARY_COMMANDS.map((command) => {
			if (command.name === "resume") {
				return {
					name: command.name,
					argumentHint: "[conversation]",
					description: command.description,
					getArgumentCompletions: () =>
						state.conversationSessions.map((session, index) => ({
							value: String(index + 1),
							label: `${index + 1}  ${session.name ?? session.firstPrompt}`,
							description: `${session.messageCount} messages · ${session.id.slice(-8)}`,
						})),
				};
			}
			if (command.name === "project") {
				return {
					name: command.name,
					argumentHint: "[project]",
					description: command.description,
					getArgumentCompletions: () =>
						workspace.projectEntries().map((project, index) => ({
							value: String(index + 1),
							label: `${index + 1}  ${basename(project.path)}`,
							description: `${project.chatCount} chats`,
						})),
				};
			}
			return { name: command.name, description: command.description };
		});
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
