import { basename } from "node:path";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { accent, dim, failure, muted, success, text, warning } from "./tui-text.ts";

export interface TuiProjectEntry {
	readonly path: string;
	readonly createdAt: string;
	readonly chatCount: number;
	readonly activeChatCount: number;
}
export type TuiChatEntry = TuiLiveCore["state"]["workspace"]["chats"][number];
export interface TuiWorkspaceCommands {
	projectEntries(): TuiProjectEntry[];
	resolveProject(selector: string): TuiProjectEntry | undefined;
	resolveChat(selector: string): TuiChatEntry | undefined;
	showProjects(): void;
	showChats(): void;
}

export function createTuiWorkspaceCommands(core: TuiLiveCore, view: TuiLiveView): TuiWorkspaceCommands {
	const { state } = core;
	const projectEntries = (): TuiProjectEntry[] => [
		{
			path: state.projectRoot,
			createdAt: "",
			chatCount: state.workspace.chats.length,
			activeChatCount: state.workspace.chats.filter(
				(chat) => chat.status === "running" || chat.status === "paused" || chat.status === "queued",
			).length,
		},
		...state.workspace.projects.filter((project) => project.path !== state.projectRoot),
	];
	const resolveProject = (selector: string) => {
		const projects = projectEntries();
		const numeric = Number.parseInt(selector, 10);
		if (String(numeric) === selector && numeric >= 1) return projects[numeric - 1];
		const normalized = selector.toLowerCase();
		const matches = projects.filter(
			(project) =>
				project.path.toLowerCase() === normalized ||
				basename(project.path).toLowerCase() === normalized ||
				project.path.toLowerCase().endsWith(normalized),
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const resolveChat = (selector: string) => {
		const numeric = Number.parseInt(selector, 10);
		if (String(numeric) === selector && numeric >= 1) return state.workspace.chats[numeric - 1];
		const normalized = selector.toLowerCase();
		const matches = state.workspace.chats.filter(
			(chat) =>
				chat.id.toLowerCase() === normalized ||
				chat.id.toLowerCase().endsWith(normalized) ||
				chat.objective.toLowerCase().includes(normalized),
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const showProjects = () => {
		view.refreshWorkspace();
		view.appendText(text("Projects"));
		for (const [index, project] of projectEntries().entries()) {
			const current = project.path === state.projectRoot ? accent("●") : dim("○");
			view.appendText(
				`${current} ${index + 1}  ${text(basename(project.path))}  ${muted(`${project.chatCount} chats${project.activeChatCount ? ` · ${project.activeChatCount} active` : ""}`)}`,
			);
		}
		view.appendText(dim("Use /project <number or name> to switch."));
	};
	const showChats = () => {
		view.refreshWorkspace();
		view.appendText(`${text("Chats")}  ${muted(basename(state.projectRoot))}`);
		if (state.workspace.chats.length === 0) {
			view.appendText(dim("No chats yet. Send a prompt to start one."));
			return;
		}
		for (const [index, chat] of state.workspace.chats.entries()) {
			const status =
				chat.status === "completed"
					? success(chat.status)
					: chat.status === "failed"
						? failure(chat.status)
						: warning(chat.status);
			view.appendText(`${index + 1}  ${status}  ${text(chat.objective)}  ${dim(chat.id.slice(-8))}`);
		}
		view.appendText(dim("Use /chat <number> to inspect or /resume <number> to recover."));
	};
	return { projectEntries, resolveProject, resolveChat, showProjects, showChats };
}
