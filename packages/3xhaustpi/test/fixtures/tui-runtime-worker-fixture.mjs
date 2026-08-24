import { fork } from "node:child_process";
import { resolve } from "node:path";

let approvalRunId;
let effectRunId;
let toolApprovalRunId;
let persistentStarts = 0;
let staleRunId;
let ignoredAbortRunId;

process.on("message", (message) => {
	if (message?.type === "start") {
		if (message.request?.objective === "wait") return;
		if (message.request?.objective === "invalid-message") {
			process.send?.({ type: "invalid", runId: message.runId });
			return;
		}
		if (message.request?.objective === "ignore-abort") {
			ignoredAbortRunId = message.runId;
			process.on("SIGTERM", () => {});
			process.send?.({
				type: "event",
				runId: message.runId,
				event: { type: "assistant.message", text: `pid:${process.pid}` },
			});
			return;
		}
		if (message.request?.objective?.startsWith("spawn-tree:")) {
			ignoredAbortRunId = message.runId;
			process.on("SIGTERM", () => {});
			const directory = message.request.objective.slice("spawn-tree:".length);
			const child = fork(resolve(import.meta.dirname, "process-tree-fixture.mjs"), [directory], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			child.once("message", (tree) => {
				if (tree?.type !== "ready") return;
				process.send?.({
					type: "event",
					runId: message.runId,
					event: { type: "assistant.message", text: `tree:${JSON.stringify(tree)}` },
				});
			});
			return;
		}
		if (message.request?.objective === "stale-prior") {
			staleRunId = message.runId;
			process.send?.({ type: "result", runId: message.runId, available: true, result: "prior" });
			return;
		}
		if (message.request?.objective === "stale-current") {
			process.send?.({
				type: "event",
				runId: staleRunId,
				event: { type: "assistant.message", text: "stale prior-run event" },
			});
			process.send?.({ type: "result", runId: message.runId, available: true, result: "current" });
			return;
		}
		if (message.request?.objective?.startsWith("persistent-")) {
			persistentStarts += 1;
			process.send?.({
				type: "result",
				runId: message.runId,
				available: true,
				result: { pid: process.pid, starts: persistentStarts },
			});
			return;
		}
		if (message.request?.objective === "effect-boundary") {
			effectRunId = message.runId;
			process.send?.({
				type: "effect",
				runId: message.runId,
				effect: { effectId: "provider_fixture", kind: "provider" },
			});
			return;
		}
		if (message.request?.objective === "tool-approval") {
			toolApprovalRunId = message.runId;
			process.send?.({
				type: "tool-approval",
				runId: message.runId,
				request: {
					approvalId: "tool_fixture",
					toolName: "write",
					summary: "write src/fixture.ts",
					preview: "fixture write preview",
				},
			});
			return;
		}
		if (message.request?.objective === "result-with-open-handle") {
			process.send?.({
				type: "result",
				runId: message.runId,
				available: true,
				result: { pid: process.pid },
			});
			setInterval(() => {}, 60_000);
			return;
		}
		if (message.request?.objective === "result-ignoring-sigterm") {
			process.on("SIGTERM", () => {});
			process.send?.({
				type: "result",
				runId: message.runId,
				available: true,
				result: { pid: process.pid },
			});
			setInterval(() => {}, 60_000);
			return;
		}
		process.send?.({
			type: "event",
			runId: message.runId,
			event: {
				type: "session.started",
				runtimeKind: "native-agent",
				sessionId: "session_fixture_worker",
				provider: "fixture-provider",
				model: "fixture-model",
				objective: message.request?.objective ?? "fixture",
			},
		});
		approvalRunId = message.runId;
		process.send?.({
			type: "approval",
			runId: message.runId,
			proposal: {
				patchId: "patch_fixture_worker",
				targetRevision: "fixture_revision",
				files: ["src/fixture.ts"],
				diff: "--- a/src/fixture.ts\n+++ b/src/fixture.ts",
			},
		});
		return;
	}
	if (message?.type === "effect-ack" && message.runId === effectRunId) {
		effectRunId = undefined;
		process.send?.({
			type: "result",
			runId: message.runId,
			available: true,
			result: { effectId: message.effectId },
		});
		setImmediate(() => process.disconnect?.());
		return;
	}
	if (message?.type === "tool-approval-decision" && message.runId === toolApprovalRunId) {
		toolApprovalRunId = undefined;
		process.send?.({
			type: "result",
			runId: message.runId,
			available: true,
			result: { approvalId: message.approvalId, approved: message.approved },
		});
		setImmediate(() => process.disconnect?.());
		return;
	}
	if (message?.type === "approval-decision" && message.runId === approvalRunId) {
		approvalRunId = undefined;
		process.send?.({
			type: "event",
			runId: message.runId,
			event: {
				type: "capability.completed",
				capability: "applyPatch",
				success: message.approved,
				durationMs: 0.5,
				summary: "fixture worker completed",
			},
		});
		process.send?.({
			type: "result",
			runId: message.runId,
			available: true,
			result: { approved: message.approved },
		});
		setImmediate(() => process.disconnect?.());
		return;
	}
	if (message?.type === "abort" && message.runId === ignoredAbortRunId) {
		process.send?.({
			type: "event",
			runId: message.runId,
			event: { type: "assistant.message", text: "stale after cancellation" },
		});
		return;
	}
	if (message?.type === "abort") {
		process.send?.({ type: "error", runId: message.runId, message: "fixture worker aborted" });
		setImmediate(() => process.disconnect?.());
	}
	if (message?.type === "shutdown") {
		if (ignoredAbortRunId) return;
		setImmediate(() => process.disconnect?.());
	}
});
