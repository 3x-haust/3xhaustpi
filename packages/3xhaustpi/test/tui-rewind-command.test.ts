import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	forkAgentConversationAtUserTurn,
	listAgentConversationRewindPoints,
	loadAgentConversation,
} from "../src/agent-session-catalog.ts";
import { RewindOverlay } from "../src/tui-rewind-overlay.ts";
import { stripAnsi } from "../src/tui-text.ts";

describe("/rewind conversation branching", () => {
	it("keeps the conversation-only guarantee visible in compact layouts", () => {
		const overlay = new RewindOverlay([{ entryId: "entry", prompt: "다시 시작할 질문", turn: 1 }], () => 4, {
			select() {},
			close() {},
		});

		const rendered = stripAnsi(overlay.render(36).join("\n"));

		expect(rendered).toContain("Conversation only");
		expect(rendered).toContain("original kept");
	});

	it("forks before a selected user turn and preserves the original", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-rewind-"));
		const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			const projectRoot = join(root, "project");
			const manager = SessionManager.create(projectRoot);
			manager.appendMessage({ role: "user", content: "First question", timestamp: Date.now() });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "First answer" }],
				api: "openai-responses",
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
				stopReason: "stop",
				timestamp: Date.now(),
			});
			manager.appendMessage({ role: "user", content: "Second question", timestamp: Date.now() });

			const points = await listAgentConversationRewindPoints(projectRoot, manager.getSessionId());
			const selected = points.at(-1);
			if (!selected) throw new Error("Expected second rewind point");
			const fork = await forkAgentConversationAtUserTurn(projectRoot, manager.getSessionId(), selected.entryId);

			expect(selected.prompt).toBe("Second question");
			expect(fork.selectedPrompt).toBe("Second question");
			expect(fork.sessionId).not.toBe(manager.getSessionId());
			expect(fork.messages.map(({ text }) => text)).toEqual(["First question", "First answer"]);
			expect((await loadAgentConversation(projectRoot, manager.getSessionId())).messages).toHaveLength(3);
		} finally {
			if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates a persisted empty branch before the first user prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-rewind-root-"));
		const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			const projectRoot = join(root, "project");
			const manager = SessionManager.create(projectRoot);
			manager.appendMessage({ role: "user", content: "First prompt", timestamp: Date.now() });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "First answer" }],
				api: "openai-responses",
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
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const point = (await listAgentConversationRewindPoints(projectRoot, manager.getSessionId())).at(0);
			if (!point) throw new Error("Expected first rewind point");

			const fork = await forkAgentConversationAtUserTurn(projectRoot, manager.getSessionId(), point.entryId);

			expect(fork.selectedPrompt).toBe("First prompt");
			expect(fork.sessionId).toBeNull();
			expect(fork.messages).toEqual([]);
		} finally {
			if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
