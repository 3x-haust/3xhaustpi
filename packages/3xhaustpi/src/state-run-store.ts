import type { DatabaseSync } from "node:sqlite";
import type { BeginRunInput } from "./state-types.ts";

export class StateRunStore {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	recoverInterrupted(): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database.exec(`
				UPDATE request_queue SET status = 'queued' WHERE status = 'running';
				UPDATE provider_outbox SET state = 'indeterminate' WHERE state IN ('dispatching', 'accepted');
				UPDATE chats SET status = 'paused' WHERE status = 'running';
			`);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	begin(input: BeginRunInput): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare("INSERT OR IGNORE INTO projects(project_id, canonical_path, created_at) VALUES (?, ?, ?)")
				.run(input.projectId, input.projectPath, now);
			this.#database
				.prepare(
					"INSERT INTO chats(session_id, project_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
				)
				.run(input.sessionId, input.projectId, now, now);
			this.#database
				.prepare(
					"INSERT INTO request_queue(request_id, session_id, position, fingerprint, payload, status, created_at) VALUES (?, ?, 1, ?, ?, 'running', ?)",
				)
				.run(input.requestId, input.sessionId, input.fingerprint, input.payload, now);
			this.#database
				.prepare("INSERT INTO checkpoints(session_id, generation, payload, updated_at) VALUES (?, ?, ?, ?)")
				.run(input.sessionId, input.generation, input.checkpoint, now);
			this.#database
				.prepare(
					"INSERT INTO provider_outbox(request_id, generation, state, payload_digest, updated_at) VALUES (?, ?, 'queued', ?, ?)",
				)
				.run(input.requestId, input.generation, input.fingerprint, now);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	complete(sessionId: string, requestId: string, status: "completed" | "failed"): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare("UPDATE request_queue SET status = ? WHERE request_id = ?")
				.run(status === "completed" ? "completed" : "failed", requestId);
			this.#database
				.prepare("UPDATE chats SET status = ?, updated_at = ? WHERE session_id = ?")
				.run(status, now, sessionId);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
}
