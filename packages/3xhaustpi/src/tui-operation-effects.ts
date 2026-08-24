import type { DatabaseSync } from "node:sqlite";
import type { TuiOperationExecutionStore } from "./tui-operation-execution.ts";
import {
	assertActiveTuiRequestLease,
	isoTimestamp,
	requireTuiRequestLease,
	runningTuiRequestRow,
} from "./tui-operation-helpers.ts";
import type {
	CompleteTuiRequestInput,
	RecordTuiRequestEffectInput,
	RunningTuiRequestRow,
	TuiRequestCompletionStatus,
} from "./tui-operation-types.ts";

export class TuiOperationEffectStore {
	readonly #database: DatabaseSync;
	readonly #executions: TuiOperationExecutionStore;

	constructor(database: DatabaseSync, executions: TuiOperationExecutionStore) {
		this.#database = database;
		this.#executions = executions;
	}

	recover(projectPath: string, now?: string): void {
		const timestamp = isoTimestamp(now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.recoverExpired(projectPath, timestamp);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	recoverExpired(projectPath: string, now: string): void {
		const indeterminateRows = this.#database
			.prepare(
				`SELECT request_id, status, owner_id, lease_epoch, effect_id,
					execution_sequence, execution_snapshot
				 FROM tui_request_queue
				 WHERE canonical_path = ? AND status = 'running'
AND (lease_expires_at IS NULL OR lease_expires_at <= ?) AND effect_id IS NOT NULL`,
			)
			.all(projectPath, now) as unknown as Array<RunningTuiRequestRow & { readonly request_id: string }>;
		for (const row of indeterminateRows) {
			if (row.owner_id === null) throw new Error("TUI request lease owner is unavailable");
			this.#executions.completeRoot(
				row.request_id,
				row.owner_id,
				row.lease_epoch,
				row.execution_sequence,
				row.execution_snapshot,
				"indeterminate",
				now,
			);
			const failed = this.#database
				.prepare(
					`UPDATE tui_request_queue SET status = 'failed', outcome = 'indeterminate', updated_at = ?
					 WHERE request_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?`,
				)
				.run(now, row.request_id, row.owner_id, row.lease_epoch);
			if (failed.changes !== 1) throw new Error("TUI request lease changed during recovery");
		}
		this.#database
			.prepare(
				`UPDATE tui_request_queue
				 SET status = 'queued', owner_id = NULL, lease_expires_at = NULL, outcome = NULL, updated_at = ?
				 WHERE canonical_path = ? AND status = 'running'
AND (lease_expires_at IS NULL OR lease_expires_at <= ?) AND effect_id IS NULL`,
			)
			.run(now, projectPath, now);
	}

	complete(requestId: string, status: TuiRequestCompletionStatus, input: CompleteTuiRequestInput): void {
		requireTuiRequestLease(input);
		const now = isoTimestamp(input.now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = runningTuiRequestRow(this.#database, requestId);
			assertActiveTuiRequestLease(row, input, now);
			if (row.owner_id === null) throw new Error("TUI request lease owner is unavailable");
			const persistedStatus = status === "canceled" ? "failed" : status;
			this.#executions.completeRoot(
				requestId,
				row.owner_id,
				row.lease_epoch,
				row.execution_sequence,
				row.execution_snapshot,
				persistedStatus,
				now,
			);
			const result = this.#database
				.prepare(
					`UPDATE tui_request_queue SET status = ?, outcome = ?, updated_at = ?
					 WHERE request_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
AND lease_expires_at > ?`,
				)
				.run(persistedStatus, status, now, requestId, row.owner_id, row.lease_epoch, now);
			if (result.changes !== 1) throw new Error("TUI request lease changed before completion");
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	record(requestId: string, input: RecordTuiRequestEffectInput): void {
		if (!input.effectId) throw new Error("TUI request effect ID is required");
		const now = isoTimestamp(input.now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = runningTuiRequestRow(this.#database, requestId);
			assertActiveTuiRequestLease(row, input, now);
			if (row.effect_id !== null) {
				if (row.effect_id !== input.effectId) throw new Error("TUI request effect ID is immutable");
				this.#database.exec("COMMIT");
				return;
			}
			const result = this.#database
				.prepare(
					`UPDATE tui_request_queue SET effect_id = ?, updated_at = ?
					 WHERE request_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
AND lease_expires_at > ? AND effect_id IS NULL`,
				)
				.run(input.effectId, now, requestId, input.ownerId, input.leaseEpoch, now);
			if (result.changes !== 1) throw new Error("TUI request effect could not be bound");
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
}
