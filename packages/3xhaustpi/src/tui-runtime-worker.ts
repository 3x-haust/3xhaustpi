import type { RuntimeWorkerMessage } from "./tui-runtime-protocol.ts";
import { TuiRuntimeWorkerExecutor } from "./tui-runtime-worker-executor.ts";
import { TuiRuntimeWorkerProtocol } from "./tui-runtime-worker-protocol.ts";
import { WorkerRunState } from "./tui-runtime-worker-run-state.ts";

const runState = new WorkerRunState();
const send = (message: RuntimeWorkerMessage): void => {
	if (process.connected) process.send?.(message);
};
const executor = new TuiRuntimeWorkerExecutor(runState, send);
let shutdownPromise: Promise<void> | undefined;

function beginShutdown(): void {
	if (shutdownPromise) return;
	const active = runState.beginShutdown(new Error("TUI runtime worker is shutting down."));
	const runId = active?.runId;
	shutdownPromise = (async () => {
		try {
			await active?.completion;
		} catch (error) {
			if (runId) protocol.sendError(runId, error);
		}
		try {
			await executor.close();
		} catch (error) {
			if (runId) protocol.sendError(runId, error);
		} finally {
			if (process.connected) process.disconnect?.();
		}
	})();
}

const protocol = new TuiRuntimeWorkerProtocol(runState, {
	send,
	execute: (request, run) => executor.execute(request, run),
	beginShutdown,
});

process.on("message", (message: unknown) => protocol.handle(message));
process.once("disconnect", beginShutdown);
