import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	listAgentConversationSessions,
	loadAgentConversation,
	resolveAgentConversationSession,
} from "../src/agent-session-catalog.ts";

const directories: string[] = [];

afterEach(() => {
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

describe("native agent session catalog", () => {
	it("lists and hydrates the same persisted conversation", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-session-catalog-"));
		directories.push(root);
		const projectRoot = join(root, "project");
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(projectRoot, sessionDir);
		manager.appendSessionInfo("Investigate queue");
		manager.appendModelChange("openai-codex", "gpt-5.6-terra");
		manager.appendThinkingLevelChange("high");
		manager.appendMessage({ role: "user", content: "Inspect the queue", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("The queue is durable."));

		const sessions = await listAgentConversationSessions(projectRoot, sessionDir);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: manager.getSessionId(),
			name: "Investigate queue",
			firstPrompt: "Inspect the queue",
			messageCount: 2,
		});
		expect(resolveAgentConversationSession(sessions, "1")?.id).toBe(manager.getSessionId());
		expect(resolveAgentConversationSession(sessions, "Investigate queue")?.id).toBe(manager.getSessionId());

		expect(await loadAgentConversation(projectRoot, manager.getSessionId(), sessionDir)).toMatchObject({
			id: manager.getSessionId(),
			name: "Investigate queue",
			model: { provider: "openai-codex", modelId: "gpt-5.6-terra" },
			thinkingLevel: "high",
			messages: [
				{ role: "user", text: "Inspect the queue" },
				{ role: "assistant", text: "The queue is durable." },
			],
		});
	});
});
