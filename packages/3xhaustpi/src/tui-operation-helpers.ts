import type { DatabaseSync } from "node:sqlite";
import { parseImagePayloads } from "./image-payload.ts";
import type {
	RunningTuiRequestRow,
	TuiDispatchBinding,
	TuiPromotionPayload,
	TuiRequest,
	TuiRequestLease,
	TuiRequestRow,
} from "./tui-operation-types.ts";

function parsePromotion(row: TuiRequestRow): TuiPromotionPayload | undefined {
	if (row.promotion_json === null && row.promotion_kind === null && row.promotion_id === null) return undefined;
	if (row.promotion_json === null || row.promotion_kind === null || row.promotion_id === null) {
		throw new Error("TUI promotion fields are incomplete");
	}
	const value: unknown = JSON.parse(row.promotion_json);
	if (value === null || typeof value !== "object" || Reflect.get(value, "version") !== 1) {
		throw new Error("Invalid TUI promotion payload");
	}
	const source = Reflect.get(value, "source");
	if (source === null || typeof source !== "object") throw new Error("Invalid TUI promotion source");
	const kind = Reflect.get(source, "kind");
	const sourceId = Reflect.get(source, "sourceId");
	const question = Reflect.get(source, "question");
	const answer = Reflect.get(source, "answer");
	const completedAt = Reflect.get(source, "completedAt");
	if (
		(kind !== "side" && kind !== "btw") ||
		typeof sourceId !== "string" ||
		typeof question !== "string" ||
		typeof answer !== "string" ||
		typeof completedAt !== "string" ||
		kind !== row.promotion_kind ||
		sourceId !== row.promotion_id
	) {
		throw new Error("Invalid TUI promotion source fields");
	}
	return { version: 1, source: { kind, sourceId, question, answer, completedAt } };
}

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
					...(row.account_id ? { accountId: row.account_id } : {}),
					...(row.thinking_level
						? { thinkingLevel: row.thinking_level as TuiDispatchBinding["thinkingLevel"] }
						: {}),
				}
			: null;
	const promotion = parsePromotion(row);
	const images = parseImagePayloads(row.images_json ? JSON.parse(row.images_json) : []);
	return {
		id: row.request_id,
		projectPath: row.canonical_path,
		objective: row.objective,
		...(images.length ? { images } : {}),
		position: row.position,
		status: row.status,
		createdAt: row.created_at,
		binding,
		...(promotion ? { promotion } : {}),
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
