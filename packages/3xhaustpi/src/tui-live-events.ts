import type { AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { CodingTaskEvent, CodingTaskPatchProposal } from "./coding-runtime.ts";
import {
	formatResponseMetrics,
	providerReportedCacheHitRatio,
	reportedContextTokens,
	updateTuiCapabilityActivity,
} from "./tui-activity-state.ts";
import {
	formatPatchApprovalReview,
	formatPatchApprovalTranscriptEntry,
	formatToolApprovalReview,
	formatToolApprovalTranscriptEntry,
} from "./tui-approval.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import { appendTaskCompletion, type TuiLiveView } from "./tui-live-view.ts";
import { failure, muted, success, text } from "./tui-text.ts";

export interface TuiTaskEvents {
	onTaskEvent(event: CodingTaskEvent): void;
	requestApproval(proposal: CodingTaskPatchProposal): Promise<boolean>;
	requestToolApproval(request: AgentToolApprovalRequest): Promise<boolean>;
}

export function conversationSessionFromEvent(
	event: CodingTaskEvent,
): { readonly sessionId: string; readonly provider: string; readonly model: string } | undefined {
	if (event.type !== "session.started" || event.runtimeKind !== "native-agent") return undefined;
	return { sessionId: event.sessionId, provider: event.provider, model: event.model };
}

export function createTuiTaskEvents(core: TuiLiveCore, view: TuiLiveView): TuiTaskEvents {
	const { state, database } = core;
	const onTaskEvent = (event: CodingTaskEvent) => {
		if (event.type === "session.started") {
			const conversation = conversationSessionFromEvent(event);
			const nextMetricsScope = `${event.sessionId}\u0000${event.provider}\u0000${event.model}`;
			if (state.metricsScope !== nextMetricsScope) {
				state.metricsScope = nextMetricsScope;
				state.latestCacheHitRatio = undefined;
			}
			state.provider = event.provider;
			state.model = event.model;
			state.responseOutputTokens = 0;
			state.responseDurationMs = 0;
			if (conversation) {
				const operation = state.activeOperation;
				if (operation?.binding) {
					database.publishTuiConversationSession(operation.id, {
						ownerId: operation.ownerId,
						leaseEpoch: operation.leaseEpoch,
						projectPath: operation.projectPath,
						expectedGeneration: operation.binding.conversationGeneration,
						sessionId: conversation.sessionId,
					});
				}
				state.agentSessionIds.set(state.projectRoot, conversation.sessionId);
				if (!operation?.binding) database.setTuiAgentSession(state.projectRoot, conversation.sessionId);
			}
			view.updateChrome();
		} else if (event.type === "model.completed") {
			state.latestContextTokens = reportedContextTokens(event.usage);
			state.responseOutputTokens += event.usage.output ?? 0;
			state.responseDurationMs += event.durationMs;
			state.latestMetricsLine = formatResponseMetrics({
				...event.usage,
				output: state.responseOutputTokens,
				durationMs: state.responseDurationMs,
			});
			state.latestCacheHitRatio = providerReportedCacheHitRatio(
				event.usage.input,
				event.usage.cacheRead,
				event.usage.cacheWrite,
			);
		} else if (event.type === "capability.started") {
			state.activeCapabilities = updateTuiCapabilityActivity(state.activeCapabilities, event.capability, "started");
			view.updateChrome(`${event.capability}…`);
		} else if (event.type === "capability.completed") {
			state.activeCapabilities = updateTuiCapabilityActivity(
				state.activeCapabilities,
				event.capability,
				"completed",
			);
			appendTaskCompletion(view, event.success, event.capability, event.durationMs, event.summary);
			const current = view.currentWorkDetail();
			view.updateChrome(current ? `${current}…` : "");
		} else if (event.type === "work.started") {
			if (state.activeOperation)
				database.recordTuiExecutionEvent(
					state.activeOperation.id,
					{ ownerId: state.activeOperation.ownerId, leaseEpoch: state.activeOperation.leaseEpoch },
					{
						type: "node.started",
						nodeId: event.workId,
						parentNodeId: event.parentWorkId ?? state.activeOperation.id,
						kind: event.kind,
						label: event.label,
					},
				);
			state.activeWork.set(event.workId, { kind: event.kind, label: event.label });
			view.updateChrome(`${event.label}…`);
		} else if (event.type === "work.completed") {
			const work = state.activeWork.get(event.workId);
			if (state.activeOperation)
				database.recordTuiExecutionEvent(
					state.activeOperation.id,
					{ ownerId: state.activeOperation.ownerId, leaseEpoch: state.activeOperation.leaseEpoch },
					{
						type: "node.completed",
						nodeId: event.workId,
						success: event.success,
						durationMs: event.durationMs,
						summary: event.summary,
					},
				);
			state.activeWork.delete(event.workId);
			appendTaskCompletion(view, event.success, work?.label ?? event.workId, event.durationMs, event.summary);
			const current = view.currentWorkDetail();
			view.updateChrome(current ? `${current}…` : "");
		} else if (event.type === "patch.proposed") {
			view.refreshWorkspace();
			state.phase = "awaiting-approval";
			view.closeHistory();
			view.followTranscript();
			view.appendPatch(event);
			view.updateChrome(`${event.files.length} file${event.files.length === 1 ? "" : "s"}`);
		} else if (event.type === "diagnostics.completed") {
			view.appendText(
				`${event.success ? success("✓") : failure("×")} ${text(event.command)}  ${muted(`${event.durationMs.toFixed(1)} ms`)}`,
			);
		} else if (event.type === "assistant.delta") view.assistantFlow.delta(event.text);
		else if (event.type === "assistant.message") view.assistantFlow.complete(event.text);
	};
	const requestApproval = (proposal: CodingTaskPatchProposal): Promise<boolean> => {
		if (!formatPatchApprovalReview(proposal).reviewable) return Promise.resolve(false);
		return new Promise((resolve, reject) => {
			if (state.approvalResolve) {
				reject(new Error("A TUI approval is already pending."));
				return;
			}
			state.approvalResolve = resolve;
			state.approvalKind = "patch";
			state.approvalReviewText = formatPatchApprovalTranscriptEntry(proposal);
			state.phase = "awaiting-approval";
			view.updateChrome("y apply · n reject");
		});
	};
	const requestToolApproval = (request: AgentToolApprovalRequest): Promise<boolean> => {
		const review = formatToolApprovalReview(request);
		const reviewText = formatToolApprovalTranscriptEntry(request);
		view.closeHistory();
		view.followTranscript();
		view.appendText(reviewText);
		if (!review.reviewable) return Promise.resolve(false);
		return new Promise((resolve, reject) => {
			if (state.approvalResolve) {
				reject(new Error("A TUI approval is already pending."));
				return;
			}
			state.approvalResolve = resolve;
			state.approvalKind = "tool";
			state.approvalToolName = request.toolName;
			state.approvalReviewText = reviewText;
			state.phase = "awaiting-approval";
			view.updateChrome(`${request.toolName} · y run · n reject`);
		});
	};
	return { onTaskEvent, requestApproval, requestToolApproval };
}
