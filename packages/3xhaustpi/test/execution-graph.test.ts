import { describe, expect, it } from "vitest";
import { applyExecutionEvent, createExecutionGraph } from "../src/execution-graph.ts";

describe("execution graph reducer", () => {
	it("projects parallel tools and delegated agents from stable identities", () => {
		const graph = [
			{
				type: "node.started" as const,
				nodeId: "root",
				kind: "root" as const,
				label: "Investigate",
			},
			{
				type: "node.started" as const,
				nodeId: "tool_read",
				parentNodeId: "root",
				kind: "tool" as const,
				label: "read",
			},
			{
				type: "node.started" as const,
				nodeId: "agent_review",
				parentNodeId: "root",
				kind: "agent" as const,
				label: "review",
			},
			{
				type: "node.completed" as const,
				nodeId: "tool_read",
				success: true,
				durationMs: 12.5,
				summary: "read done",
			},
		].reduce(applyExecutionEvent, createExecutionGraph("run_fixture"));

		expect(graph.nodes.map(({ id, kind, state }) => ({ id, kind, state }))).toEqual([
			{ id: "root", kind: "root", state: "running" },
			{ id: "tool_read", kind: "tool", state: "completed" },
			{ id: "agent_review", kind: "agent", state: "running" },
		]);
		expect(graph.activeNodeIds).toEqual(["root", "agent_review"]);
	});

	it("rejects completion for an identity that never started", () => {
		expect(() =>
			applyExecutionEvent(createExecutionGraph("run_fixture"), {
				type: "node.completed",
				nodeId: "missing",
				success: false,
				durationMs: 1,
				summary: "missing",
			}),
		).toThrow(/unknown execution node/u);
	});

	it("rejects a child whose parent identity is absent", () => {
		expect(() =>
			applyExecutionEvent(createExecutionGraph("run_fixture"), {
				type: "node.started",
				nodeId: "tool_read",
				parentNodeId: "missing_parent",
				kind: "tool",
				label: "read",
			}),
		).toThrow(/unknown parent execution node/u);
	});

	it("rejects a second terminal transition", () => {
		const started = applyExecutionEvent(createExecutionGraph("run_fixture"), {
			type: "node.started",
			nodeId: "tool_read",
			kind: "tool",
			label: "read",
		});
		const completed = applyExecutionEvent(started, {
			type: "node.completed",
			nodeId: "tool_read",
			success: true,
			durationMs: 1,
			summary: "done",
		});

		expect(() =>
			applyExecutionEvent(completed, {
				type: "node.completed",
				nodeId: "tool_read",
				success: true,
				durationMs: 2,
				summary: "done twice",
			}),
		).toThrow(/already terminal/u);
	});
});
