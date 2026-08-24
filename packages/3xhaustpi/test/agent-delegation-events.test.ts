import { describe, expect, it, vi } from "vitest";
import { createDelegatedAgentEventProjection } from "../src/agent-delegation-events.ts";
import type { CodingTaskEvent } from "../src/coding-runtime.ts";

describe("delegated agent event projection", () => {
	it("persists child session lineage and nests child tools", () => {
		const now = vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(25.5);
		const projected: CodingTaskEvent[] = [];
		const child = createDelegatedAgentEventProjection("call_delegate", "inspect auth", (event) =>
			projected.push(event),
		);
		child.onEvent({
			type: "session.started",
			runtimeKind: "native-agent",
			sessionId: "agent_child",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			objective: "inspect auth",
		});
		child.onEvent({ type: "work.started", workId: "call_read", kind: "tool", label: "read" });
		child.onEvent({
			type: "work.completed",
			workId: "call_read",
			success: true,
			durationMs: 12,
			summary: "read done",
		});
		child.onEvent({
			type: "assistant.message",
			text: "Auth is configured.",
		});
		child.onEvent({
			type: "session.completed",
			sessionId: "agent_child",
			outcome: "completed",
			decision: "completed",
			usage: { input: 1, output: 1, cacheRead: 0 },
		});

		expect(projected).toEqual([
			{
				type: "work.started",
				workId: "agent_child",
				parentWorkId: "call_delegate",
				kind: "agent",
				label: "inspect auth",
			},
			{
				type: "work.started",
				workId: "call_read",
				parentWorkId: "agent_child",
				kind: "tool",
				label: "read",
			},
			{
				type: "work.completed",
				workId: "call_read",
				success: true,
				durationMs: 12,
				summary: "read done",
			},
			{
				type: "work.completed",
				workId: "agent_child",
				success: true,
				durationMs: 15.5,
				summary: "completed",
			},
		]);
		expect(child.message()).toBe("Auth is configured.");
		now.mockRestore();
	});
});
