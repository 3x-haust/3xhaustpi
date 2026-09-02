import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderRuntime } from "../src/provider-runtime.ts";
import { createTuiAutocompleteController, type TuiAutocompleteController } from "../src/tui-live-autocomplete.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { installTuiSubmission } from "../src/tui-live-submit.ts";
import type { TuiTaskController } from "../src/tui-live-tasks.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { createTuiWorkspaceCommands } from "../src/tui-live-workspace.ts";

const directories: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("native TUI session commands", () => {
	it("resumes a Pi conversation and starts a distinct new session", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-session-command-"));
		directories.push(root);
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const projectRoot = join(root, "project");
		const manager = SessionManager.create(projectRoot);
		manager.appendSessionInfo("Queue investigation");
		manager.appendThinkingLevelChange("high");
		manager.appendMessage({ role: "user", content: "Inspect the queue", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("The queue is durable."));

		const core = createTuiLiveCore({
			projectRoot,
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);
		const workspace = createTuiWorkspaceCommands(core, view);
		const autocomplete = createTuiAutocompleteController(core, workspace);
		const tasks: TuiTaskController = {
			drainQueue() {},
			startResume() {
				throw new Error("Legacy recovery must not own /resume");
			},
		};
		autocomplete.installAutocomplete();
		installTuiSubmission({
			core,
			view,
			tasks,
			workspace,
			desktop: { startComputerCommand() {} },
			autocomplete,
			requestExit() {},
		});

		await core.editor.onSubmit?.("/resume 1");
		expect(core.database.readTuiConversationHead(projectRoot).sessionId).toBe(manager.getSessionId());
		expect(core.state.thinkingLevel).toBe("high");
		expect(core.transcriptEntries.join("\n")).toContain("Inspect the queue");
		expect(core.transcriptEntries.join("\n")).toContain("The queue is durable.");

		const resumed = core.database.readTuiConversationHead(projectRoot);
		core.state.latestContextTokens = 12_345;
		await core.editor.onSubmit?.("/new");
		expect(core.database.readTuiConversationHead(projectRoot)).toEqual({
			generation: resumed.generation + 1,
			sessionId: null,
		});
		expect(core.transcriptEntries.join("\n")).not.toContain("The queue is durable.");
		expect(core.state.latestContextTokens).toBeUndefined();

		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("clears measured context when switching model provider or project", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-context-scope-"));
		directories.push(root);
		const projectRoot = join(root, "project-a");
		const projectB = join(root, "project-b");
		const core = createTuiLiveCore({
			projectRoot,
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		core.state.workspace = {
			...core.state.workspace,
			projects: [{ path: projectB, createdAt: "", chatCount: 0, activeChatCount: 0 }],
		};
		core.database.setTuiProjectGoal(projectB, "Goal B");
		const view = createTuiLiveView(core);
		const workspace = createTuiWorkspaceCommands(core, view);
		const autocomplete: TuiAutocompleteController = {
			currentProviderModels: () => Promise.resolve(createProviderRuntime().getModels(core.state.provider)),
			eligibleProviderModels: () =>
				Promise.resolve(
					["openai-codex", "anthropic"].flatMap((provider) =>
						createProviderRuntime()
							.getModels(provider)
							.map(({ id }) => ({ provider, model: id })),
					),
				),
			installAutocomplete() {},
		};
		const tasks: TuiTaskController = {
			drainQueue() {},
			startResume() {},
		};
		installTuiSubmission({
			core,
			view,
			tasks,
			workspace,
			desktop: { startComputerCommand() {} },
			autocomplete,
			requestExit() {},
		});
		const alternate = (await autocomplete.currentProviderModels()).find(({ id }) => id !== core.state.model);
		expect(alternate).toBeDefined();

		core.state.latestContextTokens = 12_345;
		await core.editor.onSubmit?.(`/model ${alternate?.id}`);
		expect(core.state.latestContextTokens).toBeUndefined();

		core.state.latestContextTokens = 12_345;
		await core.editor.onSubmit?.("/provider anthropic");
		expect(core.state.latestContextTokens).toBeUndefined();

		core.state.latestContextTokens = 12_345;
		await core.editor.onSubmit?.("/project 2");
		expect(core.state.projectRoot).toBe(projectB);
		expect(core.state.projectGoal?.text).toBe("Goal B");
		expect(core.state.latestContextTokens).toBeUndefined();

		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("treats clear as a hidden alias for starting a new conversation", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-clear-command-"));
		directories.push(root);
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const projectRoot = join(root, "project");
		const manager = SessionManager.create(projectRoot);
		manager.appendMessage({ role: "user", content: "Preserve this session", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("This conversation is saved."));
		const core = createTuiLiveCore({
			projectRoot,
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);
		const workspace = createTuiWorkspaceCommands(core, view);
		const autocomplete = createTuiAutocompleteController(core, workspace);
		const tasks: TuiTaskController = {
			drainQueue() {},
			startResume() {
				throw new Error("Recovery must not own /clear");
			},
		};
		installTuiSubmission({
			core,
			view,
			tasks,
			workspace,
			desktop: { startComputerCommand() {} },
			autocomplete,
			requestExit() {},
		});
		await core.editor.onSubmit?.("/resume 1");
		const resumed = core.database.readTuiConversationHead(projectRoot);

		await core.editor.onSubmit?.("/clear");

		expect(core.database.readTuiConversationHead(projectRoot)).toEqual({
			generation: resumed.generation + 1,
			sessionId: null,
		});
		expect(core.transcriptEntries.join("\n")).not.toContain("This conversation is saved.");
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});
});
