import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateProcessGroup, isProcessTreeRunning, signalProcessTree } from "./process-tree.ts";
import { asError, type RuntimeParentMessage, type TuiRuntimeHostOptions } from "./tui-runtime-protocol.ts";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const maxOutputLength = 65_536;

function defaultWorkerLaunch(): { readonly path: string; readonly execArgv: readonly string[] } {
	const javascriptPath = join(runtimeDirectory, "tui-runtime-worker.js");
	if (existsSync(javascriptPath)) return { path: javascriptPath, execArgv: [] };
	return {
		path: join(runtimeDirectory, "tui-runtime-worker.ts"),
		execArgv: ["--experimental-strip-types"],
	};
}

interface TransportCallbacks {
	readonly onMessage: (message: unknown) => void;
	readonly onFailure: (error: Error) => void;
}

function appendBounded(current: string, chunk: string): string {
	if (chunk.length >= maxOutputLength) return chunk.slice(-maxOutputLength);
	return `${current}${chunk}`.slice(-maxOutputLength);
}

export class TuiRuntimeTransport {
	private readonly options: TuiRuntimeHostOptions;
	private readonly callbacks: TransportCallbacks;
	private child: ChildProcess | undefined;
	private workerExit: Promise<void> | undefined;
	private resolveWorkerExit: (() => void) | undefined;
	private closePromise: Promise<void> | undefined;
	private closing = false;
	private stdout = "";
	private stderr = "";

	constructor(options: TuiRuntimeHostOptions, callbacks: TransportCallbacks) {
		this.options = options;
		this.callbacks = callbacks;
	}

	start(): void {
		if (this.child) return;
		const launch = this.options.workerPath ? { path: this.options.workerPath, execArgv: [] } : defaultWorkerLaunch();
		const child = fork(launch.path, [], {
			detached: isolateProcessGroup,
			env: process.env,
			execArgv: [...launch.execArgv],
			serialization: "json",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.child = child;
		this.workerExit = new Promise((resolve) => {
			this.resolveWorkerExit = resolve;
		});
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.stdout = appendBounded(this.stdout, chunk);
		});
		child.stderr?.on("data", (chunk: string) => {
			this.stderr = appendBounded(this.stderr, chunk);
		});
		child.on("message", this.callbacks.onMessage);
		child.once("error", (error) => {
			if (!this.closing) this.callbacks.onFailure(error);
		});
		child.once("disconnect", () => {
			if (!this.closing) {
				this.callbacks.onFailure(new Error("TUI runtime worker disconnected unexpectedly."));
			}
		});
		child.once("close", (code, signal) => {
			this.resolveWorkerExit?.();
			this.resolveWorkerExit = undefined;
			if (this.closing) return;
			const detail = (this.stderr || this.stdout).trim().slice(-2_048);
			this.callbacks.onFailure(
				new Error(detail || `TUI runtime worker exited before completion (${signal ?? code ?? "unknown"}).`),
			);
		});
	}

	send(message: RuntimeParentMessage, onError: (error: Error) => void): boolean {
		const child = this.child;
		if (!child?.connected) return false;
		try {
			child.send(message, (error) => {
				if (error) onError(error);
			});
		} catch (error) {
			onError(asError(error));
		}
		return true;
	}

	sendIgnoringFailure(message: RuntimeParentMessage): void {
		if (!this.child?.connected) return;
		try {
			this.child.send(message, () => {});
		} catch {
			// Shutdown escalation handles a lost IPC channel.
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeWorker();
		return this.closePromise;
	}

	private async closeWorker(): Promise<void> {
		const child = this.child;
		const workerExit = this.workerExit;
		if (!child || !workerExit) return;
		this.sendIgnoringFailure({ type: "shutdown" });

		const graceMs = Math.max(0, this.options.terminationGraceMs ?? 2_000);
		const pid = child.pid;
		let termTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let reapTimer: NodeJS.Timeout | undefined;
		await new Promise<void>((resolve) => {
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				if (termTimer) clearTimeout(termTimer);
				if (killTimer) clearTimeout(killTimer);
				if (reapTimer) clearTimeout(reapTimer);
				resolve();
			};
			void workerExit.then(() => {
				if (!pid || !isProcessTreeRunning(pid)) finish();
			});
			termTimer = setTimeout(() => {
				if (finished) return;
				if (pid) signalProcessTree(pid, "SIGTERM");
				killTimer = setTimeout(() => {
					if (pid) signalProcessTree(pid, "SIGKILL");
					reapTimer = setTimeout(finish, 250);
				}, graceMs);
			}, graceMs);
		});
	}
}
