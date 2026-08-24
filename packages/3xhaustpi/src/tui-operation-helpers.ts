import type { DatabaseSync } from "node:sqlite";
import type {
	RunningTuiRequestRow,
	TuiDispatchBinding,
	TuiRequest,
	TuiRequestLease,
	TuiRequestRow,
} from "./tui-operation-types.ts";

export function isoTimestamp(value?: string): string {
	const date = value === undefined ? new Date() : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("TUI request lease timestamp is invalid");
	return date.toISOString();
}

export function mapTuiRequest(row: TuiRequestRow): TuiRequest {
	const binding: TuiDispatchBinding | null =
		row.binding_version === 1 && row.conversation_generation !== null && row.provider !== null && row.model !== null
			? {
					version: 1,
					conversationGeneration: row.conversation_generation,
					sessionId: row.session_id,
					provider: row.provider,
					model: row.model,
					...(row.thinking_level
						? { thinkingLevel: row.thinking_level as TuiDispatchBinding["thinkingLevel"] }
						: {}),
				}
			: null;
	return {
		id: row.request_id,
		projectPath: row.canonical_path,
		objective: row.objective,
		position: row.position,
		status: row.status,
		createdAt: row.created_at,
		binding,
	};
}

export function runningTuiRequestRow(database: DatabaseSync, requestId: string): RunningTuiRequestRow {
	const row = database
		.prepare(
			`SELECT status, owner_id, lease_epoch, lease_expires_at, effect_id, execution_sequence, execution_snapshot
			 FROM tui_request_queue WHERE request_id = ?`,
		)
		.get(requestId) as RunningTuiRequestRow | undefined;
	if (!row || row.status !== "running") throw new Error("TUI request is not running");
	return row;
}

export function requireTuiRequestLease(lease: unknown): asserts lease is TuiRequestLease {
	if (typeof lease !== "object" || lease === null) throw new Error("TUI request lease is required");
	const candidate = lease as Partial<TuiRequestLease>;
	if (typeof candidate.ownerId !== "string" || !candidate.ownerId.trim()) {
		throw new Error("TUI request lease owner is required");
	}
	if (!Number.isSafeInteger(candidate.leaseEpoch) || (candidate.leaseEpoch ?? 0) < 1) {
		throw new Error("TUI request lease epoch is required");
	}
}

export function assertTuiRequestLease(row: RunningTuiRequestRow, lease: TuiRequestLease): void {
	if (row.owner_id !== lease.ownerId) throw new Error("TUI request lease owner does not match");
	if (row.lease_epoch !== lease.leaseEpoch) throw new Error("TUI request lease epoch is stale");
}

export function assertActiveTuiRequestLease(row: RunningTuiRequestRow, lease: TuiRequestLease, now: string): void {
	assertTuiRequestLease(row, lease);
	if (row.lease_expires_at === null || row.lease_expires_at <= now) {
		throw new Error("TUI request lease has expired");
	}
}
