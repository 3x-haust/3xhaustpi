import { type ChildProcess, spawn } from "node:child_process";

export const isolateProcessGroup = process.platform !== "win32";

export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		try {
			const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				detached: true,
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			taskkill.once("error", () => {});
			taskkill.unref();
		} catch {
			// The process already exited or taskkill is unavailable.
		}
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process tree already exited.
		}
	}
}

export function isProcessTreeRunning(pid: number): boolean {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function waitForProcessExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("close", close);
			resolve(exited);
		};
		const close = () => finish(true);
		const timer = setTimeout(() => finish(false), milliseconds);
		child.once("close", close);
		if (child.exitCode !== null || child.signalCode !== null) finish(true);
	});
}

function waitForTerminationGrace(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

export async function terminateProcessTree(child: ChildProcess, graceMilliseconds = 250): Promise<void> {
	if (!child.pid || !isProcessTreeRunning(child.pid)) return;
	signalProcessTree(child.pid, "SIGTERM");
	await waitForProcessExit(child, graceMilliseconds);
	if (!isProcessTreeRunning(child.pid)) return;
	signalProcessTree(child.pid, "SIGKILL");
	await Promise.all([waitForProcessExit(child, graceMilliseconds), waitForTerminationGrace(graceMilliseconds)]);
}
