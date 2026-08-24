import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskEvent } from "../src/coding-runtime.ts";
import {
	createTuiRunRequest,
	runTuiRuntime,
	TuiRuntimeHost,
	TuiRuntimeHostPoisonedError,
} from "../src/tui-runtime-client.ts";
import { isWorkerMessage, type TuiRuntimeHooks } from "../src/tui-runtime-protocol.ts";

const workerPath = resolve(import.meta.dirname, "fixtures/tui-runtime-worker-fixture.mjs");
const request = (objective: string) => ({ mode: "run" as const, projectRoot: "/tmp/fixture", objective });
const hooks = (overrides: Partial<TuiRuntimeHooks> = {}): TuiRuntimeHooks => ({
	onEvent: () => {},
	requestApproval: async () => false,
	signal: new AbortController().signal,
	...overrides,
});
const fixtureWorkerPids = new Set<number>();
const temporaryDirectories: string[] = [];

function waitForFile(path: string): Promise<void> {
	return new Promise((resolveFile, reject) => {
		let finished = false;
		const filename = basename(path);
		const watcher = watch(dirname(path), (_event, changed) => {
			if ((changed === null || String(changed) === filename) && existsSync(path)) finish(resolveFile);
		});
		const timeout = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${filename}`))), 3_000);
		const finish = (settle: () => void) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			watcher.close();
			settle();
		};
		watcher.once("error", (error) => finish(() => reject(error)));
		if (existsSync(path)) finish(resolveFile);
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	const workerPids = [...fixtureWorkerPids];
	fixtureWorkerPids.clear();
	for (const workerPid of workerPids) {
		try {
			process.kill(workerPid, "SIGKILL");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
			throw error;
		}
	}
});

describe("TUI runtime worker boundary", () => {
	it("launches the default worker from an unbuilt source tree", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "3xhaustpi-source-worker-"));
		temporaryDirectories.push(projectRoot);

		await expect(
			runTuiRuntime({ mode: "resume", projectRoot }, hooks(), { terminationGraceMs: 50 }),
		).resolves.toBeUndefined();
	});

	it("forwards the model selected inside the live TUI", () => {
		expect(
			createTuiRunRequest({
				projectRoot: "/tmp/project",
				objective: "inspect",
				selectedModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
				sessionId: "session_continuation",
				allowProjectHooks: true,
			}),
		).toEqual({
			mode: "run",
			projectRoot: "/tmp/project",
			objective: "inspect",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			sessionId: "session_continuation",
			allowProjectHooks: true,
		});
	});

	it("streams bounded events and resolves a reviewed action", async () => {
		const events: CodingTaskEvent[] = [];
		const requestApproval = vi.fn(async () => true);
		const result = await runTuiRuntime(
			request("inspect fixture"),
			hooks({ onEvent: (event) => events.push(event), requestApproval }),
			{ workerPath },
		);

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(["session.started", "capability.completed"]);
		expect(result).toEqual({ approved: true });
	});

	it("rejects incomplete run-scoped worker payloads", () => {
		const runId = "12345678-1234-4123-8123-123456789abc";
		expect(
			[
				{ type: "event", runId, event: { type: "assistant.message" } },
				{ type: "approval", runId, proposal: { patchId: "patch" } },
				{ type: "effect", runId, effect: { effectId: "effect" } },
				{ type: "tool-approval", runId, request: { approvalId: "approval" } },
			].some(isWorkerMessage),
		).toBe(false);
	});

	it("propagates cancellation to the runtime worker", async () => {
		const controller = new AbortController();
		const execution = runTuiRuntime(request("wait"), hooks({ signal: controller.signal }), { workerPath });
		controller.abort();
		await expect(execution).rejects.toThrow(/cancelled/u);
	});

	it("terminates worker descendants when cancellation recycles the worker", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-worker-tree-"));
		temporaryDirectories.push(root);
		const host = new TuiRuntimeHost({ workerPath, terminationGraceMs: 50 });
		const controller = new AbortController();
		let signalStarted!: (tree: { childPid: number; grandchildPid: number }) => void;
		const started = new Promise<{ childPid: number; grandchildPid: number }>((resolveStarted) => {
			signalStarted = resolveStarted;
		});
		const execution = host.run(
			request(`spawn-tree:${root}`),
			hooks({
				onEvent: (event) => {
					if (event.type === "assistant.message" && event.text.startsWith("tree:")) {
						signalStarted(JSON.parse(event.text.slice(5)));
					}
				},
				signal: controller.signal,
			}),
		);
		const tree = await started;
		fixtureWorkerPids.add(tree.childPid);
		fixtureWorkerPids.add(tree.grandchildPid);
		const terminations =
			process.platform === "win32"
				? []
				: [waitForFile(join(root, "child-terminated")), waitForFile(join(root, "grandchild-terminated"))];
		controller.abort();
		await expect(execution).rejects.toThrow(/cancelled/u);
		await Promise.all(terminations);

		try {
			const later = await host.run(request("persistent-after-cancel"), hooks());
			expect((later as { readonly pid: number }).pid).not.toBe(tree.childPid);
			expect(() => process.kill(tree.childPid, 0)).toThrow();
			expect(() => process.kill(tree.grandchildPid, 0)).toThrow();
		} finally {
			await host.close();
		}
	}, 10_000);

	it("persists an effect boundary before acknowledging worker execution", async () => {
		const sequence: string[] = [];
		const result = await runTuiRuntime(
			request("effect-boundary"),
			hooks({ recordEffect: async (effect) => void sequence.push(`persist:${effect.effectId}`) }),
			{ workerPath },
		);
		sequence.push("result");

		expect(sequence).toEqual(["persist:provider_fixture", "result"]);
		expect(result).toEqual({ effectId: "provider_fixture" });
	});

	it("fails closed when no effect persistence hook is installed", async () => {
		await expect(runTuiRuntime(request("effect-boundary"), hooks(), { workerPath })).rejects.toThrow(
			/effect persistence hook/u,
		);
	});

	it("round-trips host approval for a native mutating tool", async () => {
		const requestToolApproval = vi.fn(async () => true);
		const result = await runTuiRuntime(request("tool-approval"), hooks({ requestToolApproval }), { workerPath });

		expect(requestToolApproval).toHaveBeenCalledWith({
			approvalId: "tool_fixture",
			toolName: "write",
			summary: "write src/fixture.ts",
			preview: "fixture write preview",
		});
		expect(result).toEqual({ approvalId: "tool_fixture", approved: true });
	});

	it("reaps a completed worker that still owns runtime handles", async () => {
		const result = await runTuiRuntime(request("result-with-open-handle"), hooks(), { workerPath });
		if (typeof result !== "object" || result === null || !("pid" in result) || typeof result.pid !== "number") {
			throw new Error("Fixture worker did not return its process id.");
		}
		const workerPid = result.pid;
		fixtureWorkerPids.add(workerPid);

		expect(() => process.kill(workerPid, 0)).toThrow();
	});

	it("escalates shutdown when a completed worker ignores SIGTERM", async () => {
		const result = await runTuiRuntime(request("result-ignoring-sigterm"), hooks(), {
			workerPath,
			terminationGraceMs: 0,
		});
		if (typeof result !== "object" || result === null || !("pid" in result) || typeof result.pid !== "number") {
			throw new Error("Fixture worker did not return its process id.");
		}
		const workerPid = result.pid;
		fixtureWorkerPids.add(workerPid);

		expect(() => process.kill(workerPid, 0)).toThrow();
	}, 1_000);

	it("reuses one warm worker across sequential TUI turns", async () => {
		const host = new TuiRuntimeHost({ workerPath });
		const commonHooks = hooks();
		try {
			const first = await host.run(request("persistent-first"), commonHooks);
			const second = await host.run(request("persistent-second"), commonHooks);

			expect(first).toMatchObject({ starts: 1 });
			expect(second).toMatchObject({ starts: 2 });
			expect((first as { readonly pid: number }).pid).toBe((second as { readonly pid: number }).pid);
		} finally {
			await host.close();
		}
	});

	it("does not route a stale prior-run message into later run hooks", async () => {
		const host = new TuiRuntimeHost({ workerPath });
		const laterEvents: CodingTaskEvent[] = [];
		try {
			await host.run(request("stale-prior"), hooks());
			const result = await host.run(
				request("stale-current"),
				hooks({ onEvent: (event) => laterEvents.push(event) }),
			);

			expect(result).toBe("current");
			expect(laterEvents).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("closes the one-shot compatibility host without a disconnect race", async () => {
		await expect(runTuiRuntime(request("persistent-one-shot"), hooks(), { workerPath })).resolves.toMatchObject({
			starts: 1,
		});
	});

	it("classifies a poisoned host so pending work can remain queued", async () => {
		const host = new TuiRuntimeHost({ workerPath });
		try {
			await expect(host.run(request("invalid-message"), hooks())).rejects.toBeInstanceOf(
				TuiRuntimeHostPoisonedError,
			);
			await expect(host.run(request("persistent-after-poison"), hooks())).rejects.toBeInstanceOf(
				TuiRuntimeHostPoisonedError,
			);
		} finally {
			await host.close();
		}
	});
});
