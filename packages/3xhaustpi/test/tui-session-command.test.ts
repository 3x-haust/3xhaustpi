import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiAutocompleteController } from "../src/tui-live-autocomplete.ts";
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
		await core.editor.onSubmit?.("/new");
		expect(core.database.readTuiConversationHead(projectRoot)).toEqual({
			generation: resumed.generation + 1,
			sessionId: null,
		});
		expect(core.transcriptEntries.join("\n")).not.toContain("The queue is durable.");

		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});
});
