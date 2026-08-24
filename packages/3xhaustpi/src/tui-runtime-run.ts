import type { AgentProviderEffectBoundaryRequest, AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { CodingTaskPatchProposal } from "./coding-runtime.ts";
import {
	asError,
	type RuntimeRunParentMessage,
	type RuntimeWorkerMessage,
	type TuiRuntimeHooks,
	type TuiRuntimeRequest,
} from "./tui-runtime-protocol.ts";

interface RunCallbacks {
	readonly send: (run: TuiRuntimeRun, message: RuntimeRunParentMessage) => void;
	readonly poison: (error: Error) => void;
	readonly recycle: (run: TuiRuntimeRun) => void;
	readonly onSettled: (run: TuiRuntimeRun) => void;
}

type RunCompletion =
	| { readonly kind: "error"; readonly error: Error }
	| { readonly kind: "result"; readonly value: unknown };

export class TuiRuntimeRun {
	readonly runId: string;
	readonly promise: Promise<unknown>;
	private readonly hooks: TuiRuntimeHooks;
	private readonly callbacks: RunCallbacks;
	private resolveRun!: (value: unknown) => void;
	private rejectRun!: (error: Error) => void;
	private pendingApproval: symbol | undefined;
	private readonly pendingEffects = new Set<string>();
	private readonly pendingToolApprovals = new Set<string>();
	private settled = false;
	private readonly abort = () => {
		if (this.settled) return;
		this.callbacks.send(this, { type: "abort", runId: this.runId });
		const reason = this.hooks.signal.reason;
		const error =
			reason instanceof Error && reason.name !== "AbortError" ? reason : new Error("TUI runtime cancelled.");
		this.fail(error);
		this.callbacks.recycle(this);
	};

	constructor(runId: string, hooks: TuiRuntimeHooks, callbacks: RunCallbacks) {
		this.runId = runId;
		this.hooks = hooks;
		this.callbacks = callbacks;
		this.promise = new Promise((resolve, reject) => {
			this.resolveRun = resolve;
			this.rejectRun = reject;
		});
	}

	start(request: TuiRuntimeRequest): void {
		this.hooks.signal.addEventListener("abort", this.abort, { once: true });
		this.callbacks.send(this, { type: "start", runId: this.runId, request });
	}

	route(message: RuntimeWorkerMessage): void {
		if (message.type === "event") {
			try {
				this.hooks.onEvent(message.event);
			} catch (error) {
				this.callbacks.poison(asError(error));
			}
			return;
		}
		if (message.type === "approval") {
			this.routeApproval(message.proposal);
			return;
		}
		if (message.type === "effect") {
			this.routeEffect(message.effect);
			return;
		}
		if (message.type === "tool-approval") {
			this.routeToolApproval(message.request);
			return;
		}
		if (message.type === "error") {
			this.finish({ kind: "error", error: new Error(message.message) });
			return;
		}
		if (this.pendingApproval || this.pendingEffects.size > 0 || this.pendingToolApprovals.size > 0) {
			this.callbacks.poison(new Error("TUI runtime worker completed with an approval or effect still pending."));
			return;
		}
		this.finish({ kind: "result", value: message.available ? message.result : undefined });
	}

	fail(error: Error): void {
		this.finish({ kind: "error", error });
	}

	private routeApproval(proposal: CodingTaskPatchProposal): void {
		if (this.pendingApproval) {
			this.callbacks.poison(new Error("TUI runtime worker requested overlapping patch approvals."));
			return;
		}
		const token = Symbol(proposal.patchId);
		this.pendingApproval = token;
		void Promise.resolve()
			.then(() => this.hooks.requestApproval(proposal))
			.then(
				(approved) => {
					if (this.settled || this.pendingApproval !== token || this.hooks.signal.aborted) return;
					this.pendingApproval = undefined;
					this.callbacks.send(this, {
						type: "approval-decision",
						runId: this.runId,
						patchId: proposal.patchId,
						approved,
					});
				},
				(error: unknown) => {
					if (!this.settled && this.pendingApproval === token) this.callbacks.poison(asError(error));
				},
			);
	}

	private routeEffect(effect: AgentProviderEffectBoundaryRequest): void {
		if (!this.hooks.recordEffect) {
			this.callbacks.poison(new Error("TUI runtime effect persistence hook is not installed."));
			return;
		}
		if (this.pendingEffects.has(effect.effectId)) {
			this.callbacks.poison(new Error(`TUI runtime worker repeated pending effect ${effect.effectId}.`));
			return;
		}
		this.pendingEffects.add(effect.effectId);
		void Promise.resolve()
			.then(() => this.hooks.recordEffect?.(effect))
			.then(
				() => {
					if (this.settled || !this.pendingEffects.delete(effect.effectId) || this.hooks.signal.aborted) return;
					this.callbacks.send(this, { type: "effect-ack", runId: this.runId, effectId: effect.effectId });
				},
				(error: unknown) => {
					if (!this.settled && this.pendingEffects.has(effect.effectId)) this.callbacks.poison(asError(error));
				},
			);
	}

	private routeToolApproval(request: AgentToolApprovalRequest): void {
		if (this.pendingToolApprovals.has(request.approvalId)) {
			this.callbacks.poison(new Error(`TUI runtime worker repeated pending tool approval ${request.approvalId}.`));
			return;
		}
		this.pendingToolApprovals.add(request.approvalId);
		void Promise.resolve()
			.then(() => this.hooks.requestToolApproval?.(request) ?? false)
			.then(
				(approved) => {
					if (this.settled || !this.pendingToolApprovals.delete(request.approvalId) || this.hooks.signal.aborted) {
						return;
					}
					this.callbacks.send(this, {
						type: "tool-approval-decision",
						runId: this.runId,
						approvalId: request.approvalId,
						approved,
					});
				},
				(error: unknown) => {
					if (!this.settled && this.pendingToolApprovals.has(request.approvalId)) {
						this.callbacks.poison(asError(error));
					}
				},
			);
	}

	private finish(completion: RunCompletion): void {
		if (this.settled) return;
		this.settled = true;
		this.hooks.signal.removeEventListener("abort", this.abort);
		this.pendingApproval = undefined;
		this.pendingEffects.clear();
		this.pendingToolApprovals.clear();
		this.callbacks.onSettled(this);
		if (completion.kind === "error") this.rejectRun(completion.error);
		else this.resolveRun(completion.value);
	}
}
