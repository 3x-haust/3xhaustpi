import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTuiTaskEvents } from "../src/tui-live-events.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiTaskController } from "../src/tui-live-tasks.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-native-drain-"));
	directories.push(root);
	const runTask = vi.fn(async () => undefined);
	const core = createTuiLiveCore({
		projectRoot: join(root, "project"),
		statePath: join(root, "state.sqlite"),
		runTask,
		resumeTask: async () => undefined,
	});
	const view = createTuiLiveView(core);
	const tasks = createTuiTaskController(core, view, createTuiTaskEvents(core, view));
	return { core, runTask, tasks, view };
}

describe("native TUI queue draining", () => {
	it("does not let a stale legacy chat block native requests", async () => {
		const { core, runTask, tasks, view } = fixture();
		core.database.beginRun({
			projectId: "project_legacy",
			projectPath: core.state.projectRoot,
			sessionId: "legacy_session",
			requestId: "legacy_request",
			fingerprint: "legacy_fingerprint",
			payload: JSON.stringify({ objective: "legacy" }),
			checkpoint: JSON.stringify({}),
			generation: 1,
		});
		core.database.enqueueTuiRequest({
			requestId: "native_request",
			projectPath: core.state.projectRoot,
			fingerprint: "native_fingerprint",
			objective: "native work",
		});

		tasks.drainQueue();

		expect(runTask).toHaveBeenCalledOnce();
		await core.state.activeExecution;
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("does not replace an admitted null session with mutable UI state", async () => {
		const { core, runTask, tasks, view } = fixture();
		core.state.agentSessionIds.set(core.state.projectRoot, "mutable_session");
		core.database.enqueueTuiRequest({
			requestId: "bound_request",
			projectPath: core.state.projectRoot,
			fingerprint: "bound_fingerprint",
			objective: "new conversation work",
			binding: {
				version: 1,
				conversationGeneration: 2,
				sessionId: null,
				provider: "openai-codex",
				model: "gpt-5.6-terra",
			},
		});

		tasks.drainQueue();

		expect(runTask).toHaveBeenCalledWith(
			core.state.projectRoot,
			"new conversation work",
			expect.any(Object),
			expect.not.objectContaining({ sessionId: "mutable_session" }),
		);
		await core.state.activeExecution;
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("resolves a pre-publication follow-up from its durable generation head", async () => {
		const { core, runTask, tasks, view } = fixture();
		core.database.compareAndSwapTuiConversationHead(core.state.projectRoot, {
			expectedGeneration: 0,
			sessionId: "published_session",
		});
		core.database.enqueueTuiRequest({
			requestId: "follow_up",
			projectPath: core.state.projectRoot,
			fingerprint: "follow_up_fingerprint",
			objective: "follow-up work",
			binding: {
				version: 1,
				conversationGeneration: 1,
				sessionId: null,
				provider: "openai-codex",
				model: "gpt-5.6-terra",
			},
		});

		tasks.drainQueue();

		expect(runTask).toHaveBeenCalledWith(
			core.state.projectRoot,
			"follow-up work",
			expect.any(Object),
			expect.objectContaining({ sessionId: "published_session" }),
		);
		await core.state.activeExecution;
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("labels explicit checkpoint recovery as recover", async () => {
		const { core, tasks, view } = fixture();

		tasks.startResume();
		await core.state.activeExecution;

		expect(core.transcriptEntries.join("\n")).toContain("/recover");
		expect(core.transcriptEntries.join("\n")).not.toContain("/resume");
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});
});
