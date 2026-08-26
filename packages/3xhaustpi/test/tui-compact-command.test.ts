import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { startCompaction } from "../src/tui-live-quick-actions.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

describe("/compact", () => {
	it("compacts the selected conversation without changing its identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-compact-"));
		const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			const projectRoot = join(root, "project");
			const manager = SessionManager.create(projectRoot);
			manager.appendMessage({ role: "user", content: "Keep deployment decisions", timestamp: Date.now() });
			let request: { readonly sessionId: string; readonly instructions?: string } | undefined;
			const core = createTuiLiveCore({
				projectRoot,
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				compactConversation: async (input) => {
					request = input;
					return { tokensBefore: 82_000, estimatedTokensAfter: 19_000 };
				},
			});
			const head = core.database.readTuiConversationHead(projectRoot);
			core.database.compareAndSwapTuiConversationHead(projectRoot, {
				expectedGeneration: head.generation,
				sessionId: manager.getSessionId(),
			});
			core.state.latestContextTokens = 82_000;
			const view = createTuiLiveView(core);

			await startCompaction("retain deployment decisions", core, view);

			expect(request).toMatchObject({
				sessionId: manager.getSessionId(),
				instructions: "retain deployment decisions",
			});
			expect(core.database.readTuiConversationHead(projectRoot).sessionId).toBe(manager.getSessionId());
			expect(core.transcriptEntries.join("\n")).toContain("Context compacted");
			expect(core.transcriptEntries.join("\n")).toContain("82K → 19K tokens (76.8% less)");
			expect(core.state.latestContextTokens).toBeUndefined();
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("adds measured context to a too-small no-op", async () => {
		// Given: a short active conversation with measured context usage.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-compact-small-"));
		const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			const projectRoot = join(root, "project");
			const manager = SessionManager.create(projectRoot);
			manager.appendMessage({ role: "user", content: "안녕", timestamp: Date.now() });
			const core = createTuiLiveCore({
				projectRoot,
				statePath: join(root, "state.sqlite"),
				contextLimit: 400_000,
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				compactConversation: async () => {
					throw new Error("Nothing to compact (session too small)");
				},
			});
			const head = core.database.readTuiConversationHead(projectRoot);
			core.database.compareAndSwapTuiConversationHead(projectRoot, {
				expectedGeneration: head.generation,
				sessionId: manager.getSessionId(),
			});
			core.state.latestContextTokens = 175;
			const view = createTuiLiveView(core);

			// When: compaction reports that the session is too small.
			await startCompaction("", core, view);

			// Then: the feedback explains the current context budget.
			expect(core.transcriptEntries.join("\n")).toContain(
				"Nothing to compact (session too small) · Context 175/400K (0.04%)",
			);
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
