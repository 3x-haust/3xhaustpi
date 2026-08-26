import type { DatabaseSync } from "node:sqlite";
import { normalizeProjectGoalText } from "./project-goal-text.ts";
import { isoTimestamp } from "./tui-operation-helpers.ts";

export type TuiProjectGoalStatus = "active" | "completed";

export interface TuiProjectGoal {
	readonly projectPath: string;
	readonly text: string;
	readonly status: TuiProjectGoalStatus;
	readonly updatedAt: string;
}

class StateGoalError extends Error {
	readonly name = "StateGoalError";
}

function parseGoalRow(value: unknown): TuiProjectGoal | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object") throw new StateGoalError("Invalid project goal row");
	const projectPath = Reflect.get(value, "canonical_path");
	const text = Reflect.get(value, "goal_text");
	const status = Reflect.get(value, "status");
	const updatedAt = Reflect.get(value, "updated_at");
	const nulPosition = Reflect.get(value, "nul_position");
	const goalBytes = Reflect.get(value, "goal_bytes");
	if (
		typeof projectPath !== "string" ||
		typeof text !== "string" ||
		(status !== "active" && status !== "completed") ||
		typeof updatedAt !== "string"
	)
		throw new StateGoalError("Invalid project goal fields");
	if (nulPosition !== 0 || typeof goalBytes !== "number" || !Number.isInteger(goalBytes) || goalBytes > 2_000)
		return undefined;
	try {
		const normalizedText = normalizeProjectGoalText(text);
		return normalizedText ? { projectPath, text: normalizedText, status, updatedAt } : undefined;
	} catch {
		return undefined;
	}
}

export class StateGoalStore {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	find(projectPath: string): TuiProjectGoal | undefined {
		return parseGoalRow(
			this.#database
				.prepare(
					`SELECT canonical_path, goal_text, status, updated_at,
					        instr(goal_text, char(0)) AS nul_position,
					        length(CAST(goal_text AS BLOB)) AS goal_bytes
					 FROM tui_project_goal WHERE canonical_path = ?`,
				)
				.get(projectPath),
		);
	}

	set(projectPath: string, text: string, now?: string): TuiProjectGoal {
		const normalizedText = normalizeProjectGoalText(text);
		if (!normalizedText) throw new StateGoalError("Project goal text must not be empty");
		const updatedAt = isoTimestamp(now);
		this.#database
			.prepare(
				`INSERT INTO tui_project_goal (canonical_path, goal_text, status, updated_at)
				 VALUES (?, ?, 'active', ?)
				 ON CONFLICT(canonical_path) DO UPDATE SET
				 goal_text = excluded.goal_text, status = 'active', updated_at = excluded.updated_at`,
			)
			.run(projectPath, normalizedText, updatedAt);
		return { projectPath, text: normalizedText, status: "active", updatedAt };
	}

	complete(projectPath: string, now?: string): TuiProjectGoal | undefined {
		const updatedAt = isoTimestamp(now);
		return parseGoalRow(
			this.#database
				.prepare(
					`UPDATE tui_project_goal SET status = 'completed', updated_at = ?
					 WHERE canonical_path = ? AND status = 'active'
					 RETURNING canonical_path, goal_text, status, updated_at,
					           instr(goal_text, char(0)) AS nul_position,
					           length(CAST(goal_text AS BLOB)) AS goal_bytes`,
				)
				.get(updatedAt, projectPath),
		);
	}

	clear(projectPath: string): void {
		this.#database.prepare("DELETE FROM tui_project_goal WHERE canonical_path = ?").run(projectPath);
	}
}
