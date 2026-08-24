export interface PendingApproval {
	readonly patchId: string;
	readonly resolve: (approved: boolean) => void;
}

export interface PendingEffect {
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

export interface ActiveWorkerRun {
	readonly runId: string;
	readonly controller: AbortController;
	pendingApproval?: PendingApproval;
	readonly pendingEffects: Map<string, PendingEffect>;
	readonly pendingToolApprovals: Map<string, (approved: boolean) => void>;
	effectAcknowledged: boolean;
	terminalErrorSent: boolean;
	completion: Promise<void>;
}

type WorkerState =
	| { readonly kind: "idle" }
	| { readonly kind: "active"; readonly run: ActiveWorkerRun }
	| { readonly kind: "shutting-down" };

export class WorkerRunState {
	private state: WorkerState = { kind: "idle" };

	get kind(): WorkerState["kind"] {
		return this.state.kind;
	}

	get active(): ActiveWorkerRun | undefined {
		return this.state.kind === "active" ? this.state.run : undefined;
	}

	createRun(runId: string): ActiveWorkerRun | undefined {
		if (this.state.kind !== "idle") return undefined;
		const run: ActiveWorkerRun = {
			runId,
			controller: new AbortController(),
			pendingEffects: new Map(),
			pendingToolApprovals: new Map(),
			effectAcknowledged: false,
			terminalErrorSent: false,
			completion: Promise.resolve(),
		};
		this.state = { kind: "active", run };
		return run;
	}

	isActive(run: ActiveWorkerRun): boolean {
		return this.state.kind === "active" && this.state.run === run;
	}

	cancellationError(run: ActiveWorkerRun): Error {
		const reason = run.controller.signal.reason;
		return reason instanceof Error ? reason : new Error("TUI runtime cancelled.");
	}

	cancel(run: ActiveWorkerRun, error: Error): void {
		if (!run.controller.signal.aborted) run.controller.abort(error);
		this.releasePending(run, error);
	}

	complete(run: ActiveWorkerRun): void {
		this.releasePending(run, new Error("TUI runtime run completed."));
		if (this.isActive(run)) this.state = { kind: "idle" };
	}

	beginShutdown(error: Error): ActiveWorkerRun | undefined {
		const active = this.active;
		this.state = { kind: "shutting-down" };
		if (active) this.cancel(active, error);
		return active;
	}

	private releasePending(run: ActiveWorkerRun, error: Error): void {
		if (run.pendingApproval) {
			const pending = run.pendingApproval;
			run.pendingApproval = undefined;
			pending.resolve(false);
		}
		for (const pending of run.pendingEffects.values()) pending.reject(error);
		run.pendingEffects.clear();
		for (const resolve of run.pendingToolApprovals.values()) resolve(false);
		run.pendingToolApprovals.clear();
	}
}
