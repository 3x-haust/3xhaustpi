import {
	isRunId,
	messageRunId,
	type RuntimeParentMessage,
	type RuntimeWorkerMessage,
	type TuiRuntimeRequest,
} from "./tui-runtime-protocol.ts";
import { hasOnlyKeys, isRecord, isRuntimeRequest } from "./tui-runtime-worker-request.ts";
import type { ActiveWorkerRun, WorkerRunState } from "./tui-runtime-worker-run-state.ts";

interface WorkerProtocolCallbacks {
	readonly send: (message: RuntimeWorkerMessage) => void;
	readonly execute: (request: TuiRuntimeRequest, run: ActiveWorkerRun) => Promise<unknown>;
	readonly beginShutdown: () => void;
}

function isShutdownMessage(value: unknown): value is { readonly type: "shutdown" } {
	return isRecord(value) && value.type === "shutdown" && hasOnlyKeys(value, ["type"]);
}

export function isRuntimeParentMessage(value: unknown): value is RuntimeParentMessage {
	if (!isRecord(value)) return false;
	if (isShutdownMessage(value)) return true;
	if (!isRunId(value.runId)) return false;
	switch (value.type) {
		case "start":
			return hasOnlyKeys(value, ["type", "runId", "request"]) && isRuntimeRequest(value.request);
		case "approval-decision":
			return (
				hasOnlyKeys(value, ["type", "runId", "patchId", "approved"]) &&
				typeof value.patchId === "string" &&
				typeof value.approved === "boolean"
			);
		case "effect-ack":
			return hasOnlyKeys(value, ["type", "runId", "effectId"]) && typeof value.effectId === "string";
		case "tool-approval-decision":
			return (
				hasOnlyKeys(value, ["type", "runId", "approvalId", "approved"]) &&
				typeof value.approvalId === "string" &&
				typeof value.approved === "boolean"
			);
		case "abort":
			return hasOnlyKeys(value, ["type", "runId"]);
		default:
			return false;
	}
}

function boundedErrorMessage(cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return detail.replace(/\s+/gu, " ").trim().slice(0, 1_024) || "TUI runtime worker failed.";
}

export class TuiRuntimeWorkerProtocol {
	private readonly runState: WorkerRunState;
	private readonly callbacks: WorkerProtocolCallbacks;

	constructor(runState: WorkerRunState, callbacks: WorkerProtocolCallbacks) {
		this.runState = runState;
		this.callbacks = callbacks;
	}

	handle(message: unknown): void {
		if (isShutdownMessage(message)) {
			this.callbacks.beginShutdown();
			return;
		}
		const run = this.runState.active;
		const incomingRunId = messageRunId(message);
		if (run && incomingRunId !== run.runId) return;
		if (!isRuntimeParentMessage(message) || message.type === "shutdown") {
			if (run) this.failRun(run, new Error("TUI runtime worker received an invalid message."));
			else if (isRunId(incomingRunId)) {
				this.sendError(incomingRunId, new Error("TUI runtime worker received an invalid message."));
			}
			return;
		}
		if (message.type === "start") {
			this.startRun(message.runId, message.request);
			return;
		}
		if (message.type === "abort") {
			if (run) this.runState.cancel(run, new Error("TUI runtime cancelled."));
			return;
		}
		if (!run) {
			this.sendError(message.runId, "TUI runtime worker has no active run.");
			return;
		}
		if (message.type === "effect-ack") {
			this.acknowledgeEffect(run, message.effectId);
			return;
		}
		if (message.type === "tool-approval-decision") {
			this.decideToolApproval(run, message.approvalId, message.approved);
			return;
		}
		this.decidePatchApproval(run, message.patchId, message.approved);
	}

	sendError(runId: string, cause: unknown): void {
		this.callbacks.send({ type: "error", runId, message: boundedErrorMessage(cause) });
	}

	private startRun(runId: string, request: TuiRuntimeRequest): void {
		const previousKind = this.runState.kind;
		const run = this.runState.createRun(runId);
		if (!run) {
			this.sendError(
				runId,
				previousKind === "active"
					? "TUI runtime worker already has an active run."
					: "TUI runtime worker is shutting down.",
			);
			return;
		}
		run.completion = this.callbacks
			.execute(request, run)
			.then((result) => {
				if (this.runState.isActive(run)) {
					this.callbacks.send({
						type: "result",
						runId: run.runId,
						available: result !== undefined,
						...(result === undefined ? {} : { result }),
					});
				}
			})
			.catch((error: unknown) => {
				if (this.runState.isActive(run) && !run.terminalErrorSent) this.sendError(run.runId, error);
			})
			.finally(() => this.runState.complete(run));
	}

	private failRun(run: ActiveWorkerRun, error: Error): void {
		if (!this.runState.isActive(run)) return;
		run.terminalErrorSent = true;
		this.sendError(run.runId, error);
		this.runState.cancel(run, error);
	}

	private acknowledgeEffect(run: ActiveWorkerRun, effectId: string): void {
		const pending = run.pendingEffects.get(effectId);
		if (!pending) {
			this.failRun(run, new Error(`TUI runtime worker has no pending effect: ${effectId}`));
			return;
		}
		run.pendingEffects.delete(effectId);
		run.effectAcknowledged = true;
		pending.resolve();
	}

	private decideToolApproval(run: ActiveWorkerRun, approvalId: string, approved: boolean): void {
		const resolve = run.pendingToolApprovals.get(approvalId);
		if (!resolve) {
			this.failRun(run, new Error(`TUI runtime worker has no pending tool approval: ${approvalId}`));
			return;
		}
		run.pendingToolApprovals.delete(approvalId);
		resolve(approved);
	}

	private decidePatchApproval(run: ActiveWorkerRun, patchId: string, approved: boolean): void {
		const pending = run.pendingApproval;
		if (!pending || pending.patchId !== patchId) {
			this.failRun(run, new Error(`TUI runtime worker has no pending approval: ${patchId}`));
			return;
		}
		run.pendingApproval = undefined;
		pending.resolve(approved);
	}
}
