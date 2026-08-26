import type { DatabaseSync } from "node:sqlite";
import { parseImagePayloads } from "./image-payload.ts";
import { isoTimestamp, mapTuiRequest } from "./tui-operation-helpers.ts";
import type { EnqueueTuiRequestInput, TuiRequest, TuiRequestRow } from "./tui-operation-types.ts";

export interface TuiRequestHistoryItem {
	readonly id: string;
	readonly status: string;
	readonly position: number;
	readonly createdAt: string;
	readonly outcome: string | null;
}

export class TuiOperationQueue {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	enqueue(input: EnqueueTuiRequestInput): { readonly request: TuiRequest; readonly inserted: boolean } {
		const images = parseImagePayloads(input.images ?? []);
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#database
				.prepare(
					`SELECT request_id, canonical_path, objective, images_json, position, status, created_at,
						binding_version, conversation_generation, session_id, provider, model, account_id, thinking_level
					 FROM tui_request_queue
					 WHERE canonical_path = ? AND fingerprint = ? AND status IN ('queued', 'running')`,
				)
				.get(input.projectPath, input.fingerprint) as TuiRequestRow | undefined;
			if (existing) {
				this.#database.exec("COMMIT");
				return { request: mapTuiRequest(existing), inserted: false };
			}
			const row = this.#database
				.prepare(
					"SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM tui_request_queue WHERE canonical_path = ?",
				)
				.get(input.projectPath) as { next_position: number };
			this.#database
				.prepare(
					`INSERT INTO tui_request_queue(
						request_id, canonical_path, position, fingerprint, objective, images_json,
						binding_version, conversation_generation, session_id, provider, model, account_id, thinking_level,
						status, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
				)
				.run(
					input.requestId,
					input.projectPath,
					row.next_position,
					input.fingerprint,
					input.objective,
					images.length ? JSON.stringify(images) : null,
					input.binding?.version ?? null,
					input.binding?.conversationGeneration ?? null,
					input.binding?.sessionId ?? null,
					input.binding?.provider ?? null,
					input.binding?.model ?? null,
					input.binding?.accountId ?? null,
					input.binding?.thinkingLevel ?? null,
					now,
					now,
				);
			this.#database.exec("COMMIT");
			return {
				request: {
					id: input.requestId,
					projectPath: input.projectPath,
					objective: input.objective,
					...(images.length ? { images } : {}),
					position: row.next_position,
					status: "queued",
					createdAt: now,
					binding: input.binding ?? null,
				},
				inserted: true,
			};
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	list(projectPath: string): readonly TuiRequest[] {
		const rows = this.#database
			.prepare(
				`SELECT request_id, canonical_path, objective, images_json, position, status, created_at,
					binding_version, conversation_generation, session_id, provider, model, account_id, thinking_level
				 FROM tui_request_queue
				 WHERE canonical_path = ? AND status IN ('queued', 'running') ORDER BY position`,
			)
			.all(projectPath) as unknown as TuiRequestRow[];
		return rows.map(mapTuiRequest);
	}

	recallNewest(projectPath: string, now?: string): TuiRequest | undefined {
		const recalledAt = isoTimestamp(now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#database
				.prepare(
					`SELECT request_id, canonical_path, objective, images_json, position, status, created_at,
						binding_version, conversation_generation, session_id, provider, model, account_id, thinking_level
					 FROM tui_request_queue
					 WHERE canonical_path = ? AND status = 'queued'
					 ORDER BY position DESC LIMIT 1`,
				)
				.get(projectPath) as TuiRequestRow | undefined;
			if (!row) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			const updated = this.#database
				.prepare(
					`UPDATE tui_request_queue
					 SET status = 'failed', outcome = 'recalled', updated_at = ?
					 WHERE request_id = ? AND status = 'queued'`,
				)
				.run(recalledAt, row.request_id);
			if (updated.changes !== 1) throw new Error("TUI pending request changed before recall");
			this.#database.exec("COMMIT");
			return mapTuiRequest(row);
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listHistory(projectPath: string): readonly TuiRequestHistoryItem[] {
		const rows = this.#database
			.prepare(
				`SELECT request_id, status, position, created_at, outcome
				 FROM tui_request_queue WHERE canonical_path = ? ORDER BY created_at DESC LIMIT 8`,
			)
			.all(projectPath) as unknown as Array<{
			request_id: string;
			status: string;
			position: number;
			created_at: string;
			outcome: string | null;
		}>;
		return rows.map((row) => ({
			id: row.request_id,
			status: row.status,
			position: row.position,
			createdAt: row.created_at,
			outcome: row.outcome,
		}));
	}
}
