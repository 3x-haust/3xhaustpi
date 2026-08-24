import { spawn } from "node:child_process";
import type { DesktopHelperRuntime } from "./desktop-runtime-contracts.ts";

export async function requestDesktopHelper(
	runtime: DesktopHelperRuntime,
	timeoutMs: number,
	request: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	return await new Promise((resolveRequest, rejectRequest) => {
		const child = spawn(runtime.command, [...runtime.args], {
			stdio: ["pipe", "pipe", "pipe"],
			env: runtime.env,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (error) rejectRequest(error);
			else resolveRequest(value);
		};
		const abort = () => {
			child.kill("SIGKILL");
			finish(new Error("Desktop Computer Use was cancelled."));
		};
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("Desktop Computer Use timed out."));
		}, timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > 1_048_576) abort();
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.length > 65_536) abort();
		});
		child.once("error", (error) => finish(error));
		child.once("close", (code) => {
			if (code !== 0) {
				finish(new Error((stderr || `${runtime.helper} exited with ${code}`).trim().slice(-2_048)));
				return;
			}
			try {
				finish(undefined, JSON.parse(stdout.trim()));
			} catch {
				finish(new Error("Desktop Computer Use returned invalid JSON."));
			}
		});
		child.stdin.end(JSON.stringify(request));
		if (signal?.aborted) abort();
	});
}
