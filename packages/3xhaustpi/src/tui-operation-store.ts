import type { DatabaseSync } from "node:sqlite";
import type { ExecutionEvent } from "./execution-graph.ts";
import { TuiOperationEffectStore } from "./tui-operation-effects.ts";
import { TuiOperationExecutionStore } from "./tui-operation-execution.ts";
import { assertActiveTuiRequestLease, isoTimestamp, runningTuiRequestRow } from "./tui-operation-helpers.ts";
import { TuiOperationLeaseStore } from "./tui-operation-leases.ts";
import { TuiOperationQueue, type TuiRequestHistoryItem } from "./tui-operation-queue.ts";
import { migrateTuiOperationSchema } from "./tui-operation-schema.ts";
import type {
	ClaimedTuiRequest,
	ClaimTuiRequestOptions,
	CompareAndSwapTuiConversationHeadInput,
	CompleteTuiRequestInput,
	EnqueueTuiRequestInput,
	PublishTuiConversationSessionInput,
	QuarantinedTuiSession,
	QuarantineTuiConversationHeadInput,
	RecordTuiExecutionEventInput,
	RecordTuiRequestEffectInput,
	RenewTuiRequestLeaseInput,
	TuiConversationHead,
	TuiExecutionProjection,
	TuiRequest,
	TuiRequestCompletionStatus,
} from "./tui-operation-types.ts";

export class TuiOperationStore {
	readonly #database: DatabaseSync;
	readonly #queue: TuiOperationQueue;
	readonly #leases: TuiOperationLeaseStore;
	readonly #effects: TuiOperationEffectStore;
	readonly #executions: TuiOperationExecutionStore;

	constructor(database: DatabaseSync) {
		migrateTuiOperationSchema(database);
		this.#database = database;
		this.#queue = new TuiOperationQueue(database);
		this.#executions = new TuiOperationExecutionStore(database);
		this.#effects = new TuiOperationEffectStore(database, this.#executions);
		this.#leases = new TuiOperationLeaseStore(database, this.#executions, this.#effects);
	}

	recoverInterrupted(projectPath: string, now?: string): void {
		this.#effects.recover(projectPath, now);
	}

	enqueue(input: EnqueueTuiRequestInput): { readonly request: TuiRequest; readonly inserted: boolean } {
		return this.#queue.enqueue(input);
	}

	list(projectPath: string): readonly TuiRequest[] {
		return this.#queue.list(projectPath);
	}

	listHistory(projectPath: string): readonly TuiRequestHistoryItem[] {
		return this.#queue.listHistory(projectPath);
	}

	listExecutionGraphs(projectPath: string): readonly TuiExecutionProjection[] {
		return this.#executions.list(projectPath);
	}

	claim(projectPath: string, options?: ClaimTuiRequestOptions): ClaimedTuiRequest | undefined {
		return this.#leases.claim(projectPath, options);
	}

	renewLease(requestId: string, input: RenewTuiRequestLeaseInput): void {
		this.#leases.renew(requestId, input);
	}

	complete(requestId: string, status: TuiRequestCompletionStatus, input: CompleteTuiRequestInput): void {
		this.#effects.complete(requestId, status, input);
	}

	recordExecutionEvent(requestId: string, input: RecordTuiExecutionEventInput, event: ExecutionEvent): void {
		this.#executions.record(requestId, input, event);
	}

	recordEffect(requestId: string, input: RecordTuiRequestEffectInput): void {
		this.#effects.record(requestId, input);
	}

	findAgentSession(projectPath: string): string | undefined {
		return this.readConversationHead(projectPath).sessionId ?? undefined;
	}

	readConversationHead(projectPath: string): TuiConversationHead {
		const row = this.#database
			.prepare("SELECT generation, session_id FROM tui_conversation_heads WHERE canonical_path = ?")
			.get(projectPath) as { readonly generation: number; readonly session_id: string | null } | undefined;
		return row ? { generation: row.generation, sessionId: row.session_id } : { generation: 0, sessionId: null };
	}

	compareAndSwapConversationHead(
		projectPath: string,
		input: CompareAndSwapTuiConversationHeadInput,
	): TuiConversationHead {
		if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
			throw new Error("TUI conversation generation is invalid");
		}
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.#database
				.prepare("SELECT generation FROM tui_conversation_heads WHERE canonical_path = ?")
				.get(projectPath) as { readonly generation: number } | undefined;
			const generation = current?.generation ?? 0;
			if (generation !== input.expectedGeneration) throw new Error("TUI conversation generation is stale");
			const nextGeneration = generation + 1;
			if (current) {
				const result = this.#database
					.prepare(
						`UPDATE tui_conversation_heads SET generation = ?, session_id = ?, updated_at = ?
						 WHERE canonical_path = ? AND generation = ?`,
					)
					.run(nextGeneration, input.sessionId, now, projectPath, generation);
				if (result.changes !== 1) throw new Error("TUI conversation generation changed");
			} else {
				this.#database
					.prepare(
						`INSERT INTO tui_conversation_heads(canonical_path, generation, session_id, updated_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(projectPath, nextGeneration, input.sessionId, now);
			}
			this.#database.exec("COMMIT");
			return { generation: nextGeneration, sessionId: input.sessionId };
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	publishConversationSession(requestId: string, input: PublishTuiConversationSessionInput): TuiConversationHead {
		const now = isoTimestamp(input.now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			assertActiveTuiRequestLease(runningTuiRequestRow(this.#database, requestId), input, now);
			const current = this.#database
				.prepare("SELECT generation, session_id FROM tui_conversation_heads WHERE canonical_path = ?")
				.get(input.projectPath) as { readonly generation: number; readonly session_id: string | null } | undefined;
			const generation = current?.generation ?? 0;
			if (generation !== input.expectedGeneration) throw new Error("TUI conversation generation is stale");
			if (current) {
				this.#database
					.prepare(
						`UPDATE tui_conversation_heads SET session_id = ?, updated_at = ?
						 WHERE canonical_path = ? AND generation = ?`,
					)
					.run(input.sessionId, now, input.projectPath, generation);
			} else {
				this.#database
					.prepare(
						`INSERT INTO tui_conversation_heads(canonical_path, generation, session_id, updated_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(input.projectPath, generation, input.sessionId, now);
			}
			this.#database.exec("COMMIT");
			return { generation, sessionId: input.sessionId };
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	quarantineConversationHead(projectPath: string, input: QuarantineTuiConversationHeadInput): TuiConversationHead {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.#database
				.prepare("SELECT generation, session_id FROM tui_conversation_heads WHERE canonical_path = ?")
				.get(projectPath) as { readonly generation: number; readonly session_id: string | null } | undefined;
			if (current?.generation !== input.expectedGeneration || current.session_id !== input.sessionId) {
				throw new Error("TUI conversation generation is stale");
			}
			this.#database
				.prepare(
					`INSERT INTO tui_session_quarantine(
						canonical_path, generation, session_id, reason, quarantined_at
					) VALUES (?, ?, ?, ?, ?)`,
				)
				.run(projectPath, current.generation, input.sessionId, input.reason, now);
			const nextGeneration = current.generation + 1;
			const cleared = this.#database
				.prepare(
					`UPDATE tui_conversation_heads SET generation = ?, session_id = NULL, updated_at = ?
					 WHERE canonical_path = ? AND generation = ? AND session_id = ?`,
				)
				.run(nextGeneration, now, projectPath, current.generation, input.sessionId);
			if (cleared.changes !== 1) throw new Error("TUI conversation generation changed");
			this.#database.exec("COMMIT");
			return { generation: nextGeneration, sessionId: null };
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listQuarantinedSessions(projectPath: string): readonly QuarantinedTuiSession[] {
		const rows = this.#database
			.prepare(
				`SELECT session_id, generation, reason, quarantined_at
				 FROM tui_session_quarantine WHERE canonical_path = ? ORDER BY quarantined_at DESC`,
			)
			.all(projectPath) as unknown as Array<{
			readonly session_id: string;
			readonly generation: number;
			readonly reason: string;
			readonly quarantined_at: string;
		}>;
		return rows.map((row) => ({
			sessionId: row.session_id,
			generation: row.generation,
			reason: row.reason,
			quarantinedAt: row.quarantined_at,
		}));
	}

	setAgentSession(projectPath: string, sessionId: string): void {
		const current = this.readConversationHead(projectPath);
		this.compareAndSwapConversationHead(projectPath, {
			expectedGeneration: current.generation,
			sessionId,
		});
	}

	clearAgentSession(projectPath: string): void {
		const current = this.readConversationHead(projectPath);
		this.compareAndSwapConversationHead(projectPath, {
			expectedGeneration: current.generation,
			sessionId: null,
		});
	}
}
