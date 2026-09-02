import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isoTimestamp } from "./tui-operation-helpers.ts";
import type {
	BeginTuiSideTurnInput,
	CompleteTuiSideTurnInput,
	RenewTuiSideTurnInput,
	TerminateTuiSideTurnInput,
	TuiAuxiliaryModelBinding,
	TuiSideChat,
	TuiSideTurn,
} from "./tui-side-chat-types.ts";

class TuiSideChatStateError extends Error {
	readonly name = "TuiSideChatStateError";
}

function requiredString(row: object, key: string): string {
	const value = Reflect.get(row, key);
	if (typeof value !== "string") throw new TuiSideChatStateError(`Invalid Side Chat ${key}`);
	return value;
}

function optionalString(row: object, key: string): string | undefined {
	const value = Reflect.get(row, key);
	if (value === null) return undefined;
	if (typeof value !== "string") throw new TuiSideChatStateError(`Invalid Side Chat ${key}`);
	return value;
}

function requiredInteger(row: object, key: string): number {
	const value = Reflect.get(row, key);
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new TuiSideChatStateError(`Invalid Side Chat ${key}`);
	}
	return value;
}

function mapChat(value: unknown): TuiSideChat {
	if (value === null || typeof value !== "object") throw new TuiSideChatStateError("Missing Side Chat");
	return {
		projectPath: requiredString(value, "canonical_path"),
		chatId: requiredString(value, "chat_id"),
		createdAt: requiredString(value, "created_at"),
		updatedAt: requiredString(value, "updated_at"),
	};
}

function mapTurn(value: unknown): TuiSideTurn {
	if (value === null || typeof value !== "object") throw new TuiSideChatStateError("Missing Side Chat turn");
	const status = requiredString(value, "status");
	if (status !== "running" && status !== "completed" && status !== "failed" && status !== "canceled") {
		throw new TuiSideChatStateError("Invalid Side Chat turn status");
	}
	const thinkingLevel = requiredString(value, "thinking_level");
	if (
		thinkingLevel !== "off" &&
		thinkingLevel !== "minimal" &&
		thinkingLevel !== "low" &&
		thinkingLevel !== "medium" &&
		thinkingLevel !== "high" &&
		thinkingLevel !== "xhigh"
	) {
		throw new TuiSideChatStateError("Invalid Side Chat thinking level");
	}
	const binding: TuiAuxiliaryModelBinding = {
		provider: requiredString(value, "provider"),
		model: requiredString(value, "model"),
		...(optionalString(value, "account_id") ? { accountId: requiredString(value, "account_id") } : {}),
		thinkingLevel,
	};
	return {
		turnId: requiredString(value, "turn_id"),
		chatId: requiredString(value, "chat_id"),
		sequence: requiredInteger(value, "sequence"),
		question: requiredString(value, "question"),
		answer: optionalString(value, "answer"),
		status,
		binding,
		ownerId: optionalString(value, "owner_id"),
		leaseEpoch: requiredInteger(value, "lease_epoch"),
		leaseExpiresAt: optionalString(value, "lease_expires_at"),
		outcome: optionalString(value, "outcome"),
		createdAt: requiredString(value, "created_at"),
		updatedAt: requiredString(value, "updated_at"),
	};
}

function expiresAt(now: string, leaseMs: number): string {
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
		throw new TuiSideChatStateError("Side Chat lease must be positive");
	return new Date(new Date(now).getTime() + leaseMs).toISOString();
}

const TURN_COLUMNS = `turn_id, chat_id, sequence, question, answer, status, provider, model, account_id,
	thinking_level, owner_id, lease_epoch, lease_expires_at, outcome, created_at, updated_at`;

export class TuiSideChatStore {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	getOrCreate(projectPath: string, now?: string): TuiSideChat {
		if (!projectPath.trim()) throw new TuiSideChatStateError("Side Chat project path is required");
		const timestamp = isoTimestamp(now);
		this.#database
			.prepare(
				`INSERT OR IGNORE INTO tui_side_chats(canonical_path, chat_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(projectPath, `side_${randomUUID()}`, timestamp, timestamp);
		return mapChat(
			this.#database
				.prepare(
					"SELECT canonical_path, chat_id, created_at, updated_at FROM tui_side_chats WHERE canonical_path = ?",
				)
				.get(projectPath),
		);
	}

	begin(input: BeginTuiSideTurnInput): TuiSideTurn {
		if (!input.turnId.trim() || !input.question.trim() || !input.ownerId.trim()) {
			throw new TuiSideChatStateError("Side Chat turn identifiers and question are required");
		}
		const now = isoTimestamp(input.now);
		const chat = this.getOrCreate(input.projectPath, now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.recoverExpiredRow(chat.chatId, now);
			const running = this.#database
				.prepare("SELECT turn_id FROM tui_side_turns WHERE chat_id = ? AND status = 'running'")
				.get(chat.chatId);
			if (running !== undefined) throw new TuiSideChatStateError("A Side Chat turn is already running");
			const sequenceRow = this.#database
				.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM tui_side_turns WHERE chat_id = ?")
				.get(chat.chatId);
			if (sequenceRow === null || typeof sequenceRow !== "object") {
				throw new TuiSideChatStateError("Unable to allocate Side Chat sequence");
			}
			const sequence = requiredInteger(sequenceRow, "next_sequence");
			this.#database
				.prepare(
					`INSERT INTO tui_side_turns(
						turn_id, chat_id, sequence, question, status, provider, model, account_id, thinking_level,
						owner_id, lease_epoch, lease_expires_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
				)
				.run(
					input.turnId,
					chat.chatId,
					sequence,
					input.question,
					input.binding.provider,
					input.binding.model,
					input.binding.accountId ?? null,
					input.binding.thinkingLevel,
					input.ownerId,
					expiresAt(now, input.leaseMs),
					now,
					now,
				);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
		return this.findTurn(input.turnId);
	}

	renew(turnId: string, input: RenewTuiSideTurnInput): void {
		const now = isoTimestamp(input.now);
		const result = this.#database
			.prepare(
				`UPDATE tui_side_turns SET lease_expires_at = ?, updated_at = ?
				 WHERE turn_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
				   AND lease_expires_at > ?`,
			)
			.run(expiresAt(now, input.leaseMs), now, turnId, input.ownerId, input.leaseEpoch, now);
		if (result.changes !== 1) throw new TuiSideChatStateError("Side Chat turn lease is stale or expired");
	}

	complete(turnId: string, input: CompleteTuiSideTurnInput): TuiSideTurn {
		if (!input.answer.trim()) throw new TuiSideChatStateError("Side Chat answer is required");
		const now = isoTimestamp(input.now);
		const value = this.#database
			.prepare(
				`UPDATE tui_side_turns SET status = 'completed', answer = ?, owner_id = NULL,
				 lease_expires_at = NULL, outcome = 'completed', updated_at = ?
				 WHERE turn_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
				   AND lease_expires_at > ?
				 RETURNING ${TURN_COLUMNS}`,
			)
			.get(input.answer, now, turnId, input.ownerId, input.leaseEpoch, now);
		if (value === undefined) throw new TuiSideChatStateError("Side Chat turn lease is stale or expired");
		return mapTurn(value);
	}

	terminate(turnId: string, input: TerminateTuiSideTurnInput): void {
		const now = isoTimestamp(input.now);
		const result = this.#database
			.prepare(
				`UPDATE tui_side_turns SET status = ?, owner_id = NULL, lease_expires_at = NULL,
				 outcome = ?, updated_at = ?
				 WHERE turn_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
				   AND lease_expires_at > ?`,
			)
			.run(input.status, input.outcome, now, turnId, input.ownerId, input.leaseEpoch, now);
		if (result.changes !== 1) throw new TuiSideChatStateError("Side Chat turn lease is stale");
	}

	recoverExpired(projectPath: string, now?: string): void {
		const chat = this.#database
			.prepare("SELECT chat_id FROM tui_side_chats WHERE canonical_path = ?")
			.get(projectPath);
		if (chat === undefined) return;
		if (chat === null || typeof chat !== "object") throw new TuiSideChatStateError("Invalid Side Chat row");
		this.recoverExpiredRow(requiredString(chat, "chat_id"), isoTimestamp(now));
	}

	list(projectPath: string): readonly TuiSideTurn[] {
		return this.#database
			.prepare(
				`SELECT ${TURN_COLUMNS} FROM tui_side_turns
				 WHERE chat_id = (SELECT chat_id FROM tui_side_chats WHERE canonical_path = ?) ORDER BY sequence`,
			)
			.all(projectPath)
			.map(mapTurn);
	}

	listCompleted(projectPath: string): readonly TuiSideTurn[] {
		return this.list(projectPath).filter(({ status }) => status === "completed");
	}

	latestCompleted(projectPath: string): TuiSideTurn | undefined {
		return this.listCompleted(projectPath).at(-1);
	}

	private findTurn(turnId: string): TuiSideTurn {
		return mapTurn(
			this.#database.prepare(`SELECT ${TURN_COLUMNS} FROM tui_side_turns WHERE turn_id = ?`).get(turnId),
		);
	}

	private recoverExpiredRow(chatId: string, now: string): void {
		this.#database
			.prepare(
				`UPDATE tui_side_turns SET status = 'failed', owner_id = NULL, lease_expires_at = NULL,
				 outcome = 'interrupted', updated_at = ?
				 WHERE chat_id = ? AND status = 'running' AND lease_expires_at <= ?`,
			)
			.run(now, chatId, now);
	}
}
