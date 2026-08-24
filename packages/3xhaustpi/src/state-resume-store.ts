import type { DatabaseSync } from "node:sqlite";
import type { ExplicitResumeClaim, ResumeCheckpoint } from "./state-types.ts";

export class StateResumeStore {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	markDispatching(requestId: string, generation: number): void {
		const result = this.#database
			.prepare(
				"UPDATE provider_outbox SET state = 'dispatching', updated_at = ? WHERE request_id = ? AND generation = ? AND state = 'queued'",
			)
			.run(new Date().toISOString(), requestId, generation);
		if (result.changes === 1) return;
		const row = this.#database
			.prepare("SELECT generation, state FROM provider_outbox WHERE request_id = ?")
			.get(requestId) as { generation: number; state: string } | undefined;
		if (!row) throw new Error("Provider outbox request is unavailable");
		if (row.generation !== generation) throw new Error("Provider outbox generation is stale");
		throw new Error(`Provider outbox is ${row.state}; automatic dispatch is blocked`);
	}

	settle(requestId: string, providerRequestId: string | undefined): void {
		const result = this.#database
			.prepare(
				"UPDATE provider_outbox SET state = 'settled', provider_request_id = ?, updated_at = ? WHERE request_id = ? AND state = 'dispatching'",
			)
			.run(providerRequestId ?? null, new Date().toISOString(), requestId);
		if (result.changes !== 1) throw new Error("Provider outbox could not be settled from dispatching");
	}

	settleAndCheckpoint(
		requestId: string,
		sessionId: string,
		generation: number,
		providerRequestId: string | undefined,
		checkpoint: string,
	): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const settled = this.#database
				.prepare(
					"UPDATE provider_outbox SET state = 'settled', provider_request_id = ?, updated_at = ? WHERE request_id = ? AND generation = ? AND state = 'dispatching'",
				)
				.run(providerRequestId ?? null, now, requestId, generation);
			if (settled.changes !== 1) throw new Error("Provider outbox could not be settled from dispatching");
			this.writeCheckpoint(sessionId, generation, checkpoint, now);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	prepareDispatch(
		requestId: string,
		sessionId: string,
		generation: number,
		payloadDigest: string,
		checkpoint: string,
	): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const prepared = this.#database
				.prepare(
					`UPDATE provider_outbox
					 SET generation = ?, state = 'queued', payload_digest = ?, provider_request_id = NULL, updated_at = ?
					 WHERE request_id = ? AND state = 'settled'`,
				)
				.run(generation, payloadDigest, now, requestId);
			if (prepared.changes !== 1) throw new Error("Provider outbox is not safely settled for the next dispatch");
			this.writeCheckpoint(sessionId, generation, checkpoint, now);
			this.#database.prepare("UPDATE request_queue SET status = 'running' WHERE request_id = ?").run(requestId);
			this.#database
				.prepare("UPDATE chats SET status = 'running', updated_at = ? WHERE session_id = ?")
				.run(now, sessionId);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	updateCheckpoint(sessionId: string, generation: number, checkpoint: string): void {
		const result = this.#database
			.prepare("UPDATE checkpoints SET generation = ?, payload = ?, updated_at = ? WHERE session_id = ?")
			.run(generation, checkpoint, new Date().toISOString(), sessionId);
		if (result.changes !== 1) throw new Error("Durable checkpoint is unavailable");
	}

	private writeCheckpoint(sessionId: string, generation: number, checkpoint: string, now: string): void {
		this.#database
			.prepare("UPDATE checkpoints SET generation = ?, payload = ?, updated_at = ? WHERE session_id = ?")
			.run(generation, checkpoint, now, sessionId);
	}

	find(sessionId?: string, projectPath?: string): ResumeCheckpoint | undefined {
		const row = this.#database
			.prepare(`
				SELECT chats.session_id, projects.canonical_path, checkpoints.payload, checkpoints.generation,
					checkpoints.updated_at, request_queue.request_id, request_queue.payload AS request_payload,
					request_queue.fingerprint, provider_outbox.state AS outbox_state
				FROM checkpoints
				JOIN chats ON chats.session_id = checkpoints.session_id
				JOIN projects ON projects.project_id = chats.project_id
				JOIN request_queue ON request_queue.session_id = chats.session_id
				JOIN provider_outbox ON provider_outbox.request_id = request_queue.request_id
				WHERE chats.status IN ('paused', 'queued', 'failed') AND request_queue.status <> 'indeterminate'
					${sessionId ? "AND chats.session_id = ?" : ""}
					${projectPath ? "AND projects.canonical_path = ?" : ""}
				ORDER BY checkpoints.updated_at DESC LIMIT 1
			`)
			.get(...(sessionId ? [sessionId] : []), ...(projectPath ? [projectPath] : [])) as ResumeRow | undefined;
		return row ? mapResumeCheckpoint(row) : undefined;
	}

	claim(sessionId?: string, projectPath?: string): ResumeCheckpoint | undefined {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const checkpoint = this.find(sessionId, projectPath);
			if (!checkpoint) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			this.assertSafe(checkpoint);
			this.claimCheckpoint(checkpoint);
			this.#database.exec("COMMIT");
			return checkpoint;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	claimExplicit(sessionId?: string, projectPath?: string): ExplicitResumeClaim | undefined {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const checkpoint = this.find(sessionId, projectPath);
			if (!checkpoint) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			if (checkpoint.outboxState === "indeterminate") {
				this.retireIndeterminate(checkpoint);
				this.#database.exec("COMMIT");
				return { kind: "restart", checkpoint };
			}
			this.assertSafe(checkpoint);
			this.claimCheckpoint(checkpoint);
			this.#database.exec("COMMIT");
			return { kind: "checkpoint", checkpoint };
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	private assertSafe(checkpoint: ResumeCheckpoint): void {
		if (checkpoint.outboxState === "indeterminate") {
			throw new Error(
				"Provider receipt is indeterminate; automatic resend is blocked. Inspect the provider before retrying.",
			);
		}
		if (checkpoint.outboxState !== "queued" && checkpoint.outboxState !== "settled") {
			throw new Error(`Provider outbox is ${checkpoint.outboxState}; resume is not safe`);
		}
	}

	private claimCheckpoint(checkpoint: ResumeCheckpoint): void {
		const claimed = this.#database
			.prepare(
				"UPDATE chats SET status = 'running', updated_at = ? WHERE session_id = ? AND status IN ('paused', 'queued', 'failed')",
			)
			.run(new Date().toISOString(), checkpoint.sessionId);
		if (claimed.changes !== 1) throw new Error("Durable checkpoint was claimed by another runtime");
		this.#database
			.prepare("UPDATE request_queue SET status = 'running' WHERE request_id = ?")
			.run(checkpoint.requestId);
	}

	private retireIndeterminate(checkpoint: ResumeCheckpoint): void {
		const request = this.#database
			.prepare(
				"UPDATE request_queue SET status = 'indeterminate' WHERE request_id = ? AND status IN ('queued', 'running', 'failed')",
			)
			.run(checkpoint.requestId);
		if (request.changes !== 1) throw new Error("Indeterminate provider request could not be retired");
		const chat = this.#database
			.prepare(
				"UPDATE chats SET status = 'failed', updated_at = ? WHERE session_id = ? AND status IN ('paused', 'queued', 'failed')",
			)
			.run(new Date().toISOString(), checkpoint.sessionId);
		if (chat.changes !== 1) throw new Error("Indeterminate provider session could not be retired");
	}
}

interface ResumeRow {
	readonly session_id: string;
	readonly canonical_path: string;
	readonly payload: string;
	readonly generation: number;
	readonly updated_at: string;
	readonly request_id: string;
	readonly request_payload: string;
	readonly fingerprint: string;
	readonly outbox_state: ResumeCheckpoint["outboxState"];
}

function mapResumeCheckpoint(row: ResumeRow): ResumeCheckpoint {
	return {
		sessionId: row.session_id,
		projectPath: row.canonical_path,
		payload: row.payload,
		requestId: row.request_id,
		requestPayload: row.request_payload,
		fingerprint: row.fingerprint,
		generation: row.generation,
		outboxState: row.outbox_state,
		updatedAt: row.updated_at,
	};
}
