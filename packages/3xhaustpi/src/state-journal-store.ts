import type { DatabaseSync } from "node:sqlite";

export type PatchState = "proposed" | "approved" | "applied" | "conflict" | "rejected";

export class StateJournalStore {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	recordObservation(sessionId: string, observationId: string, payload: string): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#database
				.prepare("SELECT payload FROM observations WHERE observation_id = ?")
				.get(observationId) as { payload: string } | undefined;
			if (existing && existing.payload !== payload) {
				throw new Error("Content-addressed observation payload does not match its existing ID");
			}
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO observations(observation_id, session_id, payload, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(observationId, sessionId, payload, now);
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO observation_sessions(session_id, observation_id, created_at) VALUES (?, ?, ?)",
				)
				.run(sessionId, observationId, now);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	recordPatch(sessionId: string, patchId: string, baseRevision: string, state: PatchState, payload: string): void {
		const now = new Date().toISOString();
		this.#database
			.prepare(
				`INSERT INTO patch_journal(patch_id, session_id, base_revision, state, payload, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(patch_id) DO UPDATE SET state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`,
			)
			.run(patchId, sessionId, baseRevision, state, payload, now, now);
	}
}
