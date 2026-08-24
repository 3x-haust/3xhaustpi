import { randomUUID } from "node:crypto";
import {
	isWorkerMessage,
	messageRunId,
	type RuntimeParentMessage,
	type TuiRuntimeHooks,
	type TuiRuntimeHostOptions,
	type TuiRuntimeRequest,
} from "./tui-runtime-protocol.ts";
import { TuiRuntimeRun } from "./tui-runtime-run.ts";
import { TuiRuntimeTransport } from "./tui-runtime-transport.ts";

export class TuiRuntimeHostPoisonedError extends Error {
	constructor(cause: Error) {
		super(`TUI runtime host failed: ${cause.message}`, { cause });
		this.name = "TuiRuntimeHostPoisonedError";
	}
}

export class TuiRuntimeHost {
	private readonly options: TuiRuntimeHostOptions;
	private transport: TuiRuntimeTransport | undefined;
	private active: TuiRuntimeRun | undefined;
	private failure: Error | undefined;
	private recyclePromise: Promise<void> | undefined;
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: TuiRuntimeHostOptions = {}) {
		this.options = options;
	}

	run(request: TuiRuntimeRequest, hooks: TuiRuntimeHooks): Promise<unknown> {
		if (this.active) return Promise.reject(new Error("TUI runtime host already has an active run."));
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.reject(new Error("TUI runtime host is closed."));
		if (hooks.signal.aborted) {
			return Promise.reject(
				hooks.signal.reason instanceof Error ? hooks.signal.reason : new Error("TUI runtime cancelled."),
			);
		}
		const recycling = this.recyclePromise;
		if (recycling) return recycling.then(() => this.run(request, hooks));

		try {
			this.ensureTransport();
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}

		const run = new TuiRuntimeRun(randomUUID(), hooks, {
			send: (source, message) => this.sendForRun(source, message),
			poison: (error) => this.poison(error),
			recycle: () => this.recycleTransport(),
			onSettled: (source) => {
				if (this.active === source) this.active = undefined;
			},
		});
		this.active = run;
		run.start(request);
		return run.promise;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		const active = this.active;
		if (active) {
			this.sendWithoutFailure({ type: "abort", runId: active.runId });
			active.fail(new Error("TUI runtime host was closed during a run."));
		}
		const recycling = this.recyclePromise;
		this.closePromise = (async () => {
			await recycling;
			await this.transport?.close();
		})();
		return this.closePromise;
	}

	private ensureTransport(): void {
		if (this.transport) return;
		const transport = new TuiRuntimeTransport(this.options, {
			onMessage: (message) => this.routeMessage(message),
			onFailure: (error) => this.poison(error),
		});
		transport.start();
		this.transport = transport;
	}

	private routeMessage(message: unknown): void {
		if (this.closed) return;
		const run = this.active;
		if (!run || messageRunId(message) !== run.runId) return;
		if (!isWorkerMessage(message)) {
			this.poison(new Error("TUI runtime worker returned an invalid message."));
			return;
		}
		run.route(message);
	}

	private sendForRun(run: TuiRuntimeRun, message: RuntimeParentMessage): void {
		const sent = this.transport?.send(message, (error) => {
			if (this.active === run) this.poison(error);
		});
		if (!sent && this.active === run) this.poison(new Error("TUI runtime worker IPC is unavailable."));
	}

	private sendWithoutFailure(message: RuntimeParentMessage): void {
		this.transport?.sendIgnoringFailure(message);
	}

	private recycleTransport(): void {
		if (this.closed || this.recyclePromise) return;
		const transport = this.transport;
		if (!transport) return;
		this.transport = undefined;
		const recycling = transport.close().finally(() => {
			if (this.recyclePromise === recycling) this.recyclePromise = undefined;
		});
		this.recyclePromise = recycling;
	}

	private poison(error: Error): void {
		if (!this.failure) {
			this.failure = error instanceof TuiRuntimeHostPoisonedError ? error : new TuiRuntimeHostPoisonedError(error);
		}
		const active = this.active;
		if (active) {
			this.sendWithoutFailure({ type: "abort", runId: active.runId });
			active.fail(this.failure);
		}
		void this.close();
	}
}
