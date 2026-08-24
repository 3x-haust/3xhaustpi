import type { DatabaseSync } from "node:sqlite";
import type { TuiOperationEffectStore } from "./tui-operation-effects.ts";
import type { TuiOperationExecutionStore } from "./tui-operation-execution.ts";
import {
	assertActiveTuiRequestLease,
	isoTimestamp,
	mapTuiRequest,
	runningTuiRequestRow,
} from "./tui-operation-helpers.ts";
import type {
	ClaimedTuiRequest,
	ClaimTuiRequestOptions,
	RenewTuiRequestLeaseInput,
	TuiRequestRow,
} from "./tui-operation-types.ts";

const DEFAULT_LEASE_MS = 60_000;
const LEGACY_OWNER_ID = "legacy";

interface ClaimableTuiRequestRow extends TuiRequestRow {
	readonly lease_epoch: number;
	readonly execution_sequence: number;
	readonly execution_snapshot: string | null;
}

export class TuiOperationLeaseStore {
	readonly #database: DatabaseSync;
	readonly #executions: TuiOperationExecutionStore;
	readonly #effects: TuiOperationEffectStore;

	constructor(database: DatabaseSync, executions: TuiOperationExecutionStore, effects: TuiOperationEffectStore) {
		this.#database = database;
		this.#executions = executions;
		this.#effects = effects;
	}

	claim(projectPath: string, options?: ClaimTuiRequestOptions): ClaimedTuiRequest | undefined {
		const ownerId = options?.ownerId ?? LEGACY_OWNER_ID;
		if (!ownerId.trim()) throw new Error("TUI request lease owner is required");
		const now = isoTimestamp(options?.now);
		const leaseMs = options === undefined ? 0 : (options.leaseMs ?? DEFAULT_LEASE_MS);
		if (!Number.isSafeInteger(leaseMs) || leaseMs < 0) {
			throw new Error("TUI request lease duration must be a non-negative integer");
		}
		const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#effects.recoverExpired(projectPath, now);
			const liveLease = this.#database
				.prepare(
					`SELECT 1 FROM tui_request_queue
					 WHERE canonical_path = ? AND status = 'running' AND lease_expires_at > ? LIMIT 1`,
				)
				.get(projectPath, now);
			if (liveLease) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			const row = this.#database
				.prepare(
					`SELECT request_id, canonical_path, objective, position, status, created_at, lease_epoch,
						execution_sequence, execution_snapshot, binding_version, conversation_generation,
						session_id, provider, model, thinking_level
					 FROM tui_request_queue
					 WHERE canonical_path = ? AND status = 'queued'
${options?.requestId ? "AND request_id = ?" : ""}
					 ORDER BY position LIMIT 1`,
				)
				.get(projectPath, ...(options?.requestId ? [options.requestId] : [])) as ClaimableTuiRequestRow | undefined;
			if (!row) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			const leaseEpoch = row.lease_epoch + 1;
			const claimed = this.#database
				.prepare(
					`UPDATE tui_request_queue
					 SET status = 'running', owner_id = ?, lease_epoch = ?, lease_expires_at = ?, outcome = NULL,
updated_at = ?
					 WHERE request_id = ? AND status = 'queued'`,
				)
				.run(ownerId, leaseEpoch, leaseExpiresAt, now, row.request_id);
			if (claimed.changes !== 1) throw new Error("TUI request was claimed by another runtime");
			if (row.execution_sequence === 0) {
				if (row.execution_snapshot !== null) throw new Error("TUI execution snapshot has no event sequence");
				this.#executions.initializeRoot(row.request_id, row.objective, ownerId, leaseEpoch, now);
			} else {
				this.#executions.validate(row.request_id, row.execution_sequence, row.execution_snapshot);
			}
			this.#database.exec("COMMIT");
			return {
				...mapTuiRequest({ ...row, status: "running" }),
				status: "running",
				ownerId,
				leaseEpoch,
			};
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	renew(requestId: string, input: RenewTuiRequestLeaseInput): void {
		const now = isoTimestamp(input.now);
		if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
			throw new Error("TUI request lease duration must be a positive integer");
		}
		const leaseExpiresAt = new Date(new Date(now).getTime() + input.leaseMs).toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = runningTuiRequestRow(this.#database, requestId);
			assertActiveTuiRequestLease(row, input, now);
			const result = this.#database
				.prepare(
					`UPDATE tui_request_queue
					 SET lease_expires_at = CASE
WHEN lease_expires_at < ? THEN ? ELSE lease_expires_at
					 END, updated_at = ?
					 WHERE request_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
AND lease_expires_at > ?`,
				)
				.run(leaseExpiresAt, leaseExpiresAt, now, requestId, input.ownerId, input.leaseEpoch, now);
			if (result.changes !== 1) throw new Error("TUI request lease fence changed before renewal");
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
}
