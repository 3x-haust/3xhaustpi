import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionEvent } from "./execution-graph.ts";
import { resolveStatePath } from "./identity.ts";
import { StateJournalStore } from "./state-journal-store.ts";
import { StateResumeStore } from "./state-resume-store.ts";
import { StateRunStore } from "./state-run-store.ts";
import { migrateStateSchema } from "./state-schema.ts";
import type { BeginRunInput, ExplicitResumeClaim, ResumeCheckpoint, WorkspaceSnapshot } from "./state-types.ts";
import { StateWorkspaceStore } from "./state-workspace-store.ts";
import { TuiOperationStore } from "./tui-operation-store.ts";
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

export type { BeginRunInput, ExplicitResumeClaim, ResumeCheckpoint, WorkspaceSnapshot } from "./state-types.ts";
export type {
	ClaimedTuiRequest,
	ClaimTuiRequestOptions,
	CompleteTuiRequestInput,
	EnqueueTuiRequestInput,
	RecordTuiExecutionEventInput,
	RecordTuiRequestEffectInput,
	RenewTuiRequestLeaseInput,
	TuiExecutionProjection,
	TuiRequest,
	TuiRequestLease,
} from "./tui-operation-types.ts";

export class ThreeXhaustState {
	readonly #database: DatabaseSync;
	readonly #runs: StateRunStore;
	readonly #resume: StateResumeStore;
	readonly #journal: StateJournalStore;
	readonly #workspace: StateWorkspaceStore;
	readonly #tuiOperations: TuiOperationStore;

	constructor(path = resolveStatePath()) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#database = new DatabaseSync(path);
		this.#database.exec(
			"PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
		);
		migrateStateSchema(this.#database);
		this.#tuiOperations = new TuiOperationStore(this.#database);
		this.#runs = new StateRunStore(this.#database);
		this.#resume = new StateResumeStore(this.#database);
		this.#journal = new StateJournalStore(this.#database);
		this.#workspace = new StateWorkspaceStore(this.#database, (projectPath) =>
			this.#tuiOperations.listHistory(projectPath),
		);
	}

	recoverInterruptedRuns(): void {
		this.#runs.recoverInterrupted();
	}

	recoverInterruptedTuiRequests(projectPath: string, now?: string): void {
		this.#tuiOperations.recoverInterrupted(projectPath, now);
	}

	enqueueTuiRequest(input: EnqueueTuiRequestInput): { readonly request: TuiRequest; readonly inserted: boolean } {
		return this.#tuiOperations.enqueue(input);
	}

	listTuiRequests(projectPath: string): readonly TuiRequest[] {
		return this.#tuiOperations.list(projectPath);
	}

	claimNextTuiRequest(projectPath: string, options?: ClaimTuiRequestOptions): ClaimedTuiRequest | undefined {
		return this.#tuiOperations.claim(projectPath, options);
	}

	renewTuiRequestLease(requestId: string, input: RenewTuiRequestLeaseInput): void {
		this.#tuiOperations.renewLease(requestId, input);
	}

	completeTuiRequest(requestId: string, status: TuiRequestCompletionStatus, input: CompleteTuiRequestInput): void {
		this.#tuiOperations.complete(requestId, status, input);
	}

	listTuiRequestHistory(projectPath: string) {
		return this.#tuiOperations.listHistory(projectPath);
	}

	recordTuiExecutionEvent(requestId: string, input: RecordTuiExecutionEventInput, event: ExecutionEvent): void {
		this.#tuiOperations.recordExecutionEvent(requestId, input, event);
	}

	listTuiExecutionGraphs(projectPath: string): readonly TuiExecutionProjection[] {
		return this.#tuiOperations.listExecutionGraphs(projectPath);
	}

	recordTuiRequestEffect(requestId: string, input: RecordTuiRequestEffectInput): void {
		this.#tuiOperations.recordEffect(requestId, input);
	}

	findTuiAgentSession(projectPath: string): string | undefined {
		return this.#tuiOperations.findAgentSession(projectPath);
	}

	readTuiConversationHead(projectPath: string): TuiConversationHead {
		return this.#tuiOperations.readConversationHead(projectPath);
	}

	compareAndSwapTuiConversationHead(
		projectPath: string,
		input: CompareAndSwapTuiConversationHeadInput,
	): TuiConversationHead {
		return this.#tuiOperations.compareAndSwapConversationHead(projectPath, input);
	}

	publishTuiConversationSession(requestId: string, input: PublishTuiConversationSessionInput): TuiConversationHead {
		return this.#tuiOperations.publishConversationSession(requestId, input);
	}

	quarantineTuiConversationHead(projectPath: string, input: QuarantineTuiConversationHeadInput): TuiConversationHead {
		return this.#tuiOperations.quarantineConversationHead(projectPath, input);
	}

	listQuarantinedTuiSessions(projectPath: string): readonly QuarantinedTuiSession[] {
		return this.#tuiOperations.listQuarantinedSessions(projectPath);
	}

	setTuiAgentSession(projectPath: string, sessionId: string): void {
		this.#tuiOperations.setAgentSession(projectPath, sessionId);
	}

	clearTuiAgentSession(projectPath: string): void {
		this.#tuiOperations.clearAgentSession(projectPath);
	}

	beginRun(input: BeginRunInput): void {
		this.#runs.begin(input);
	}

	markProviderDispatching(requestId: string, generation: number): void {
		this.#resume.markDispatching(requestId, generation);
	}

	settleProvider(requestId: string, providerRequestId: string | undefined): void {
		this.#resume.settle(requestId, providerRequestId);
	}

	settleProviderAndCheckpoint(
		requestId: string,
		sessionId: string,
		generation: number,
		providerRequestId: string | undefined,
		checkpoint: string,
	): void {
		this.#resume.settleAndCheckpoint(requestId, sessionId, generation, providerRequestId, checkpoint);
	}

	prepareProviderDispatch(
		requestId: string,
		sessionId: string,
		generation: number,
		payloadDigest: string,
		checkpoint: string,
	): void {
		this.#resume.prepareDispatch(requestId, sessionId, generation, payloadDigest, checkpoint);
	}

	updateCheckpoint(sessionId: string, generation: number, checkpoint: string): void {
		this.#resume.updateCheckpoint(sessionId, generation, checkpoint);
	}

	recordObservation(sessionId: string, observationId: string, payload: string): void {
		this.#journal.recordObservation(sessionId, observationId, payload);
	}

	recordPatch(
		sessionId: string,
		patchId: string,
		baseRevision: string,
		state: "proposed" | "approved" | "applied" | "conflict" | "rejected",
		payload: string,
	): void {
		this.#journal.recordPatch(sessionId, patchId, baseRevision, state, payload);
	}

	completeRun(sessionId: string, requestId: string, status: "completed" | "failed"): void {
		this.#runs.complete(sessionId, requestId, status);
	}

	findResumeCheckpoint(sessionId?: string, projectPath?: string): ResumeCheckpoint | undefined {
		return this.#resume.find(sessionId, projectPath);
	}

	claimResumeCheckpoint(sessionId?: string, projectPath?: string): ResumeCheckpoint | undefined {
		return this.#resume.claim(sessionId, projectPath);
	}

	claimExplicitResume(sessionId?: string, projectPath?: string): ExplicitResumeClaim | undefined {
		return this.#resume.claimExplicit(sessionId, projectPath);
	}

	inspectWorkspace(projectPath: string): WorkspaceSnapshot {
		return this.#workspace.inspect(projectPath);
	}

	close(): void {
		this.#database.close();
	}
}
