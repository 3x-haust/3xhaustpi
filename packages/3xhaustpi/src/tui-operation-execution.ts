import type { DatabaseSync } from "node:sqlite";
import {
	applyExecutionEvent,
	createExecutionGraph,
	type ExecutionEvent,
	type ExecutionGraph,
	parseExecutionEvent,
	parseExecutionGraphJson,
} from "./execution-graph.ts";
import { assertActiveTuiRequestLease, isoTimestamp, runningTuiRequestRow } from "./tui-operation-helpers.ts";
import type { RecordTuiExecutionEventInput, TuiExecutionProjection } from "./tui-operation-types.ts";

interface TuiExecutionRow {
	readonly request_id: string;
	readonly objective: string;
	readonly status: string;
	readonly execution_sequence: number;
	readonly execution_snapshot: string;
}

export class TuiOperationExecutionStore {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	list(projectPath: string): readonly TuiExecutionProjection[] {
		const rows = this.#database
			.prepare(
				`SELECT request_id, objective, status, execution_sequence, execution_snapshot
				 FROM tui_request_queue
				 WHERE canonical_path = ? AND execution_snapshot IS NOT NULL
				 ORDER BY updated_at DESC, position DESC`,
			)
			.all(projectPath) as unknown as TuiExecutionRow[];
		return rows.map((row) => {
			if (
				row.status !== "queued" &&
				row.status !== "running" &&
				row.status !== "completed" &&
				row.status !== "failed"
			) {
				throw new Error(`persisted TUI request status is invalid: ${row.status}`);
			}
			return {
				requestId: row.request_id,
				objective: row.objective,
				status: row.status,
				graph: this.graph(row.request_id, row.execution_sequence, row.execution_snapshot),
			};
		});
	}

	record(requestId: string, input: RecordTuiExecutionEventInput, event: ExecutionEvent): void {
		const now = isoTimestamp(input.now);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = runningTuiRequestRow(this.#database, requestId);
			assertActiveTuiRequestLease(row, input, now);
			const persistedEvent = parseExecutionEvent(event);
			if (
				(persistedEvent.type === "node.completed" && persistedEvent.nodeId === requestId) ||
				(persistedEvent.type === "node.started" && persistedEvent.kind === "root")
			) {
				throw new Error("TUI execution root lifecycle is controlled by its request");
			}
			const graph = this.graph(requestId, row.execution_sequence, row.execution_snapshot);
			this.append(requestId, input.ownerId, input.leaseEpoch, row.execution_sequence, graph, persistedEvent, now);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	initializeRoot(requestId: string, objective: string, ownerId: string, leaseEpoch: number, now: string): void {
		this.append(
			requestId,
			ownerId,
			leaseEpoch,
			0,
			createExecutionGraph(requestId),
			{
				type: "node.started",
				nodeId: requestId,
				kind: "root",
				label: objective,
			},
			now,
		);
	}

	completeRoot(
		requestId: string,
		ownerId: string,
		leaseEpoch: number,
		sequence: number,
		snapshot: string | null,
		status: "completed" | "failed" | "indeterminate",
		now: string,
	): void {
		let graph = this.graph(requestId, sequence, snapshot);
		let nextSequence = sequence;
		for (const nodeId of [...graph.activeNodeIds].reverse()) {
			if (nodeId === requestId) continue;
			graph = this.append(
				requestId,
				ownerId,
				leaseEpoch,
				nextSequence,
				graph,
				{
					type: "node.completed",
					nodeId,
					success: false,
					durationMs: 0,
					summary: `${status}: unfinished`,
				},
				now,
			);
			nextSequence += 1;
		}
		this.append(
			requestId,
			ownerId,
			leaseEpoch,
			nextSequence,
			graph,
			{
				type: "node.completed",
				nodeId: requestId,
				success: status === "completed",
				durationMs: 0,
				summary: status,
			},
			now,
		);
	}

	validate(requestId: string, sequence: number, snapshot: string | null): void {
		this.graph(requestId, sequence, snapshot);
	}

	private graph(requestId: string, sequence: number, snapshot: string | null): ExecutionGraph {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || snapshot === null) {
			throw new Error("TUI execution projection is unavailable");
		}
		const events = this.#database
			.prepare(
				`SELECT COUNT(*) AS event_count, COALESCE(MAX(sequence), 0) AS maximum_sequence
				 FROM tui_execution_events WHERE request_id = ?`,
			)
			.get(requestId) as { readonly event_count: number; readonly maximum_sequence: number };
		if (events.event_count !== sequence || events.maximum_sequence !== sequence) {
			throw new Error("TUI execution event sequence is not contiguous");
		}
		const graph = parseExecutionGraphJson(snapshot);
		const root = graph.nodes[0];
		if (
			graph.runId !== requestId ||
			root?.id !== requestId ||
			root.kind !== "root" ||
			root.parentNodeId !== undefined
		) {
			throw new Error("persisted TUI execution root is invalid");
		}
		return graph;
	}

	private append(
		requestId: string,
		ownerId: string,
		leaseEpoch: number,
		sequence: number,
		graph: ExecutionGraph,
		event: ExecutionEvent,
		now: string,
	): ExecutionGraph {
		const nextSequence = sequence + 1;
		if (!Number.isSafeInteger(nextSequence)) throw new Error("TUI execution event sequence is exhausted");
		const nextGraph = applyExecutionEvent(graph, event);
		this.#database
			.prepare(
				`INSERT INTO tui_execution_events(request_id, sequence, event_json, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(requestId, nextSequence, JSON.stringify(event), now);
		const updated = this.#database
			.prepare(
				`UPDATE tui_request_queue SET execution_sequence = ?, execution_snapshot = ?, updated_at = ?
				 WHERE request_id = ? AND status = 'running' AND owner_id = ? AND lease_epoch = ?
AND execution_sequence = ?`,
			)
			.run(nextSequence, JSON.stringify(nextGraph), now, requestId, ownerId, leaseEpoch, sequence);
		if (updated.changes !== 1) throw new Error("TUI request lease changed before recording execution event");
		return nextGraph;
	}
}
