import {
	type AgentProviderEffectBoundaryRequest,
	AgentRuntimeHost,
	type AgentToolApprovalRequest,
} from "./agent-runtime.ts";
import { resumeCodingTask, type runCodingTask } from "./coding-runtime.ts";
import type { RuntimeWorkerMessage, TuiRuntimeRequest } from "./tui-runtime-protocol.ts";
import type { ActiveWorkerRun, WorkerRunState } from "./tui-runtime-worker-run-state.ts";

type SendMessage = (message: RuntimeWorkerMessage) => void;
type CodingTaskHooks = {
	onEvent: NonNullable<Parameters<typeof runCodingTask>[0]["onEvent"]>;
	requestApproval: NonNullable<Parameters<typeof runCodingTask>[0]["requestApproval"]>;
	recordEffectBoundary: (effect: AgentProviderEffectBoundaryRequest) => Promise<void>;
	requestToolApproval: (request: AgentToolApprovalRequest) => Promise<boolean>;
	signal: AbortSignal;
};

export class TuiRuntimeWorkerExecutor {
	private readonly agentRuntimeHost = new AgentRuntimeHost();
	private readonly runState: WorkerRunState;
	private readonly send: SendMessage;

	constructor(runState: WorkerRunState, send: SendMessage) {
		this.runState = runState;
		this.send = send;
	}

	async execute(request: TuiRuntimeRequest, run: ActiveWorkerRun): Promise<unknown> {
		const hooks = this.createHooks(run);
		const result =
			request.mode === "run"
				? await this.executeRun(request, hooks)
				: await resumeCodingTask({
						projectRoot: request.projectRoot,
						approve: false,
						...hooks,
						resources: { enabled: true, allowProjectHooks: request.allowProjectHooks },
						...(request.sessionId ? { sessionId: request.sessionId } : {}),
					});
		if (run.controller.signal.aborted) throw this.runState.cancellationError(run);
		return result;
	}

	close(): Promise<void> {
		return this.agentRuntimeHost.close();
	}

	private createHooks(run: ActiveWorkerRun): CodingTaskHooks {
		return {
			onEvent: (event) => {
				if (this.runState.isActive(run)) this.send({ type: "event", runId: run.runId, event });
			},
			requestApproval: (proposal) =>
				new Promise<boolean>((resolve) => {
					if (!this.runState.isActive(run)) {
						resolve(false);
						return;
					}
					if (run.pendingApproval) throw new Error("A TUI runtime approval is already pending.");
					run.pendingApproval = { patchId: proposal.patchId, resolve };
					this.send({ type: "approval", runId: run.runId, proposal });
				}),
			recordEffectBoundary: (effect) =>
				new Promise<void>((resolve, reject) => {
					if (!this.runState.isActive(run)) {
						reject(this.runState.cancellationError(run));
						return;
					}
					if (run.pendingEffects.has(effect.effectId)) {
						throw new Error(`TUI runtime effect is already pending: ${effect.effectId}`);
					}
					run.pendingEffects.set(effect.effectId, { resolve, reject });
					this.send({ type: "effect", runId: run.runId, effect });
				}),
			requestToolApproval: (request) =>
				new Promise<boolean>((resolve) => {
					if (!this.runState.isActive(run)) {
						resolve(false);
						return;
					}
					if (run.pendingToolApprovals.has(request.approvalId)) {
						throw new Error(`TUI runtime tool approval is already pending: ${request.approvalId}`);
					}
					run.pendingToolApprovals.set(request.approvalId, resolve);
					this.send({ type: "tool-approval", runId: run.runId, request });
				}),
			signal: run.controller.signal,
		};
	}

	private async executeRun(
		request: Extract<TuiRuntimeRequest, { mode: "run" }>,
		hooks: CodingTaskHooks,
	): Promise<unknown> {
		return this.agentRuntimeHost.run({
			projectRoot: request.projectRoot,
			objective: request.objective,
			...(request.provider ? { provider: request.provider } : {}),
			...(request.model ? { model: request.model } : {}),
			...(request.sessionId ? { sessionId: request.sessionId } : {}),
			...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
			signal: hooks.signal,
			onEvent: hooks.onEvent,
			requestToolApproval: hooks.requestToolApproval,
			recordEffectBoundary: hooks.recordEffectBoundary,
		});
	}
}
