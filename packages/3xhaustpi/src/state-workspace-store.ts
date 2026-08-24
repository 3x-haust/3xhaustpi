import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceSnapshot } from "./state-types.ts";

export interface RequestHistoryItem {
	readonly id: string;
	readonly status: string;
	readonly position: number;
	readonly createdAt: string;
}

export class StateWorkspaceStore {
	readonly #database: DatabaseSync;
	readonly #listTuiHistory: (projectPath: string) => readonly RequestHistoryItem[];

	constructor(database: DatabaseSync, listTuiHistory: (projectPath: string) => readonly RequestHistoryItem[]) {
		this.#database = database;
		this.#listTuiHistory = listTuiHistory;
	}

	inspect(projectPath: string): WorkspaceSnapshot {
		const projects = this.#database
			.prepare(`
				SELECT projects.canonical_path, projects.created_at,
					COUNT(chats.session_id) AS chat_count,
					COALESCE(SUM(CASE WHEN chats.status IN ('queued', 'running', 'paused') THEN 1 ELSE 0 END), 0)
						AS active_chat_count
				FROM projects
				LEFT JOIN chats ON chats.project_id = projects.project_id
				GROUP BY projects.project_id
				ORDER BY MAX(COALESCE(chats.updated_at, projects.created_at)) DESC
				LIMIT 20
			`)
			.all() as unknown as ProjectRow[];
		const chats = this.#database
			.prepare(`
				SELECT chats.session_id, chats.status, chats.updated_at, request_queue.payload
				FROM chats JOIN projects ON projects.project_id = chats.project_id
				LEFT JOIN request_queue ON request_queue.session_id = chats.session_id AND request_queue.position = 1
				WHERE projects.canonical_path = ?
				ORDER BY chats.updated_at DESC LIMIT 20
			`)
			.all(projectPath) as unknown as ChatRow[];
		const runRequests = this.#database
			.prepare(`
				SELECT request_queue.request_id, request_queue.status, request_queue.position, request_queue.created_at
				FROM request_queue
				JOIN chats ON chats.session_id = request_queue.session_id
				JOIN projects ON projects.project_id = chats.project_id
				WHERE projects.canonical_path = ?
				ORDER BY request_queue.created_at DESC LIMIT 8
			`)
			.all(projectPath) as unknown as RunRequestRow[];
		const requests = [
			...runRequests.map((row) => ({
				id: row.request_id,
				status: row.status,
				position: row.position,
				createdAt: row.created_at,
			})),
			...this.#listTuiHistory(projectPath),
		]
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			.slice(0, 8);
		const patches = this.#database
			.prepare(`
				SELECT patch_journal.patch_id, patch_journal.state, patch_journal.updated_at
				FROM patch_journal
				JOIN chats ON chats.session_id = patch_journal.session_id
				JOIN projects ON projects.project_id = chats.project_id
				WHERE projects.canonical_path = ?
				ORDER BY patch_journal.updated_at DESC LIMIT 8
			`)
			.all(projectPath) as unknown as PatchRow[];
		return {
			projects: projects.map((row) => ({
				path: row.canonical_path,
				createdAt: row.created_at,
				chatCount: row.chat_count,
				activeChatCount: row.active_chat_count,
			})),
			chats: chats.map(mapChat),
			requests: requests.map(({ id, status, position }) => ({ id, status, position })),
			patches: patches.map((row) => ({ id: row.patch_id, state: row.state, updatedAt: row.updated_at })),
		};
	}
}

interface ProjectRow {
	readonly canonical_path: string;
	readonly created_at: string;
	readonly chat_count: number;
	readonly active_chat_count: number;
}
interface ChatRow {
	readonly session_id: string;
	readonly status: string;
	readonly updated_at: string;
	readonly payload: string | null;
}
interface RunRequestRow {
	readonly request_id: string;
	readonly status: string;
	readonly position: number;
	readonly created_at: string;
}
interface PatchRow {
	readonly patch_id: string;
	readonly state: string;
	readonly updated_at: string;
}

function mapChat(row: ChatRow): WorkspaceSnapshot["chats"][number] {
	let objective = "Untitled task";
	if (row.payload) {
		try {
			const payload: unknown = JSON.parse(row.payload);
			if (
				typeof payload === "object" &&
				payload !== null &&
				"objective" in payload &&
				typeof payload.objective === "string" &&
				payload.objective.trim()
			) {
				objective = payload.objective.trim();
			}
		} catch {
			objective = "Unreadable task";
		}
	}
	return { id: row.session_id, status: row.status, updatedAt: row.updated_at, objective };
}
