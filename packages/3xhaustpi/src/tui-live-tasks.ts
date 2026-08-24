import { randomUUID } from "node:crypto";
import type { AgentProviderEffectBoundaryRequest } from "./agent-runtime.ts";
import type { ClaimedTuiRequest } from "./state.ts";
import type { TuiTaskEvents } from "./tui-live-events.ts";
import { TUI_REQUEST_LEASE_MS, TUI_REQUEST_LEASE_RENEWAL_MS, type TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { TuiRuntimeHostPoisonedError } from "./tui-runtime-client.ts";
import { failure, muted, success } from "./tui-text.ts";

export interface TuiTaskController {
	drainQueue(): void;
	startResume(sessionId?: string): void;
}

export function createTuiTaskController(
	core: TuiLiveCore,
	view: TuiLiveView,
	events: TuiTaskEvents,
): TuiTaskController {
	const { state, database, input } = core;
	const execute = async (request: ClaimedTuiRequest | undefined, resumeSessionId: string | undefined) => {
		const resume = resumeSessionId !== undefined;
		const previousPatchId = state.workspace.patches[0]?.id;
		state.phase = "running";
		state.canceledActive = false;
		state.latestMetricsLine = undefined;
		state.activeCapabilities = [];
		state.activeWork.clear();
		state.activeOperation = request;
		view.assistantFlow.reset();
		const controller = new AbortController();
		state.activeController = controller;
		let leaseFailure: Error | undefined;
		const renewLease = () => {
			if (!request) return;
			try {
				database.renewTuiRequestLease(request.id, {
					ownerId: request.ownerId,
					leaseEpoch: request.leaseEpoch,
					now: new Date().toISOString(),
					leaseMs: TUI_REQUEST_LEASE_MS,
				});
			} catch (error) {
				leaseFailure = error instanceof Error ? error : new Error(String(error));
				state.activeController?.abort(leaseFailure);
			}
		};
		const leaseRenewalTimer = request ? setInterval(renewLease, TUI_REQUEST_LEASE_RENEWAL_MS) : undefined;
		leaseRenewalTimer?.unref();
		const clearLeaseRenewal = () => {
			if (leaseRenewalTimer) clearInterval(leaseRenewalTimer);
		};
		if (resume) view.appendUser(`/recover ${resumeSessionId === "" ? "" : resumeSessionId.slice(-8)}`.trim());
		view.updateChrome(resume ? "recovering…" : "planning…");
		try {
			const hooks = {
				onEvent: events.onTaskEvent,
				requestApproval: events.requestApproval,
				recordEffect: async (effect: AgentProviderEffectBoundaryRequest) => {
					if (!request) throw new Error("Provider effects require a durable TUI request.");
					database.recordTuiRequestEffect(request.id, {
						ownerId: request.ownerId,
						leaseEpoch: request.leaseEpoch,
						effectId: effect.effectId,
					});
				},
				requestToolApproval: events.requestToolApproval,
				signal: controller.signal,
			};
			const conversationHead =
				request?.binding?.sessionId === null ? database.readTuiConversationHead(state.projectRoot) : undefined;
			let sessionId = request?.binding?.sessionId ?? undefined;
			if (!sessionId && conversationHead && conversationHead.generation === request?.binding?.conversationGeneration)
				sessionId = conversationHead.sessionId ?? undefined;
			const result = resume
				? await input.resumeTask(state.projectRoot, resumeSessionId || undefined, hooks)
				: await input.runTask(state.projectRoot, request?.objective ?? "", hooks, {
						provider: request?.binding?.provider ?? state.provider,
						model: request?.binding?.model ?? state.model,
						thinkingLevel: request?.binding?.thinkingLevel ?? state.thinkingLevel,
						...(sessionId ? { sessionId } : {}),
					});
			clearLeaseRenewal();
			if (leaseFailure) throw leaseFailure;
			if (controller.signal.aborted) throw controller.signal.reason ?? new Error("TUI request cancelled.");
			if (resume && result === undefined) {
				if (request)
					database.completeTuiRequest(request.id, "failed", {
						ownerId: request.ownerId,
						leaseEpoch: request.leaseEpoch,
					});
				state.phase = "ready";
				view.appendText(muted("No durable checkpoint is available."));
				return;
			}
			if (request)
				database.completeTuiRequest(request.id, "completed", {
					ownerId: request.ownerId,
					leaseEpoch: request.leaseEpoch,
				});
			view.refreshWorkspace();
			const applied =
				state.workspace.patches[0]?.id !== previousPatchId && state.workspace.patches[0]?.state === "applied";
			state.phase = applied ? "success" : "ready";
			if (applied) view.appendText(success("✓ Patch applied and diagnostics passed"));
		} catch (error) {
			clearLeaseRenewal();
			if (error instanceof TuiRuntimeHostPoisonedError) state.runtimePoisoned = true;
			let failureCause = error;
			if (request) {
				try {
					database.completeTuiRequest(request.id, state.canceledActive ? "canceled" : "failed", {
						ownerId: request.ownerId,
						leaseEpoch: request.leaseEpoch,
					});
				} catch (completionError) {
					failureCause = completionError;
				}
			}
			view.refreshWorkspace();
			if (state.runtimePoisoned)
				view.appendText(failure("Runtime stopped. Pending tasks are preserved; restart 3xhaustPi to continue."));
			else if (state.canceledActive) view.appendText(muted("Canceled. Pending tasks were preserved."));
			else
				view.appendText(
					failure(`Error: ${failureCause instanceof Error ? failureCause.message : String(failureCause)}`),
				);
			state.phase = "ready";
		} finally {
			clearLeaseRenewal();
			state.activeController = undefined;
			state.approvalResolve = undefined;
			state.approvalKind = undefined;
			state.approvalToolName = undefined;
			state.approvalReviewText = undefined;
			state.activeOperation = undefined;
			state.canceledActive = false;
			state.activeCapabilities = [];
			state.activeWork.clear();
			view.refreshQueue();
			view.updateChrome("");
		}
	};
	const drainQueue = () => {
		if (
			!state.active ||
			state.runtimePoisoned ||
			state.activeExecution ||
			(state.phase !== "ready" && state.phase !== "success")
		)
			return;
		view.refreshWorkspace();
		const next = database.claimNextTuiRequest(state.projectRoot, {
			ownerId: core.hostOwnerId,
			leaseMs: TUI_REQUEST_LEASE_MS,
		});
		if (!next) {
			view.refreshQueue();
			return;
		}
		view.refreshQueue();
		const execution = execute(next, undefined);
		state.activeExecution = execution;
		void execution.finally(() => {
			if (state.activeExecution === execution) state.activeExecution = undefined;
			view.updateChrome("");
			if (!state.active) core.finish();
			else drainQueue();
		});
	};
	const startResume = (sessionId?: string) => {
		if (!state.active || state.activeExecution) return;
		const requestId = `tui_resume_${randomUUID()}`;
		database.enqueueTuiRequest({
			requestId,
			projectPath: state.projectRoot,
			fingerprint: requestId,
			objective: sessionId ? `Resume ${sessionId}` : "Resume latest checkpoint",
		});
		const request = database.claimNextTuiRequest(state.projectRoot, {
			ownerId: core.hostOwnerId,
			requestId,
			leaseMs: TUI_REQUEST_LEASE_MS,
		});
		if (!request) throw new Error("Unable to claim the durable resume operation.");
		const execution = execute(request, sessionId ?? "");
		state.activeExecution = execution;
		void execution.finally(() => {
			if (state.activeExecution === execution) state.activeExecution = undefined;
			view.updateChrome("");
			if (!state.active) core.finish();
			else drainQueue();
		});
	};
	return { drainQueue, startResume };
}
