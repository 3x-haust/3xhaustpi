import {
	listAgentConversationSessions,
	loadAgentConversation,
	resolveAgentConversationSession,
} from "./agent-session-catalog.ts";
import type { TuiAutocompleteController } from "./tui-live-autocomplete.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiTaskController } from "./tui-live-tasks.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { dim, success, text, warning } from "./tui-text.ts";

export async function handleTuiSessionCommand(
	command: string,
	argument: string,
	deps: {
		readonly core: TuiLiveCore;
		readonly view: TuiLiveView;
		readonly tasks: TuiTaskController;
		readonly autocomplete: TuiAutocompleteController;
	},
): Promise<boolean> {
	if (!["sessions", "chats", "chat", "resume", "new", "recover"].includes(command)) return false;
	const { core, view, tasks, autocomplete } = deps;
	const { state, database, editor } = core;
	const refresh = async () => {
		state.conversationSessions = await listAgentConversationSessions(state.projectRoot);
		autocomplete.installAutocomplete();
		return state.conversationSessions;
	};
	if (command === "sessions" || command === "chats") {
		const sessions = await refresh();
		view.appendText(text("Sessions"));
		if (sessions.length === 0) view.appendText(dim("No saved sessions in this project."));
		for (const [index, session] of sessions.entries()) {
			view.appendText(
				`${index + 1}  ${text(session.name ?? session.firstPrompt)}  ${dim(`${session.messageCount} messages · ${session.id.slice(-8)}`)}`,
			);
		}
		return true;
	}
	if (command === "chat" || command === "resume") {
		if (state.activeExecution || state.queuedRequests.length > 0) {
			view.appendText(warning("Finish active and pending work before switching sessions."));
			return true;
		}
		const sessions = await refresh();
		if (!argument) {
			if (sessions.length === 0) view.appendText(dim("No saved sessions in this project."));
			else {
				editor.setText("/resume ");
				editor.handleInput("\t");
			}
			return true;
		}
		const session = resolveAgentConversationSession(sessions, argument);
		if (!session) {
			view.appendText(warning(`Session not found or ambiguous: ${argument}`));
			editor.setText("/resume ");
			editor.handleInput("\t");
			return true;
		}
		const conversation = await loadAgentConversation(state.projectRoot, session.id);
		const head = database.readTuiConversationHead(state.projectRoot);
		if (head.sessionId !== session.id) {
			database.compareAndSwapTuiConversationHead(state.projectRoot, {
				expectedGeneration: head.generation,
				sessionId: session.id,
			});
		}
		state.agentSessionIds.set(state.projectRoot, session.id);
		if (conversation.model) {
			state.provider = conversation.model.provider;
			state.model = conversation.model.modelId;
		}
		state.thinkingLevel = conversation.thinkingLevel;
		view.replaceConversation(conversation.messages);
		view.updateChrome();
		return true;
	}
	if (command === "new") {
		if (state.activeExecution || state.queuedRequests.length > 0) {
			view.appendText(warning("Finish active and pending work before starting a new session."));
			return true;
		}
		const head = database.readTuiConversationHead(state.projectRoot);
		database.compareAndSwapTuiConversationHead(state.projectRoot, {
			expectedGeneration: head.generation,
			sessionId: null,
		});
		state.agentSessionIds.delete(state.projectRoot);
		view.replaceConversation([]);
		view.appendText(success("● New session"));
		return true;
	}
	if (state.activeExecution) view.appendText(warning("A task is already active."));
	else tasks.startResume(argument || undefined);
	return true;
}
