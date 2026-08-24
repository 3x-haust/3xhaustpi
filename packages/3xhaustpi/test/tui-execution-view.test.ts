import { describe, expect, it } from "vitest";
import type { TuiExecutionProjection } from "../src/state.ts";
import { formatExecutionGraphLines } from "../src/tui-execution-view.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

const projection: TuiExecutionProjection = {
	requestId: "operation_graph",
	objective: "Inspect authentication and delegate review",
	status: "running",
	graph: {
		runId: "operation_graph",
		activeNodeIds: ["operation_graph", "agent_review"],
		nodes: [
			{ id: "operation_graph", kind: "root", label: "Inspect authentication and delegate review", state: "running" },
			{
				id: "call_read",
				parentNodeId: "operation_graph",
				kind: "tool",
				label: "read",
				state: "completed",
				durationMs: 12.5,
				summary: "read done",
			},
			{
				id: "agent_review",
				parentNodeId: "operation_graph",
				kind: "agent",
				label: "review",
				state: "running",
			},
			{
				id: "child_grep",
				parentNodeId: "agent_review",
				kind: "tool",
				label: "grep",
				state: "completed",
				durationMs: 4,
				summary: "grep done",
			},
		],
	},
};

describe("execution graph TUI projection", () => {
	it("renders honest state, hierarchy, and measured duration", () => {
		const lines = formatExecutionGraphLines(projection, 80).map(stripAnsi);
		expect(lines[0]).toContain("Work graph");
		expect(lines[0]).toContain("2 active");
		expect(lines).toContain("├─ ✓ read  12.5 ms · read done");
		expect(lines).toContain("└─ • agent review");
		expect(lines).toContain("   └─ ✓ grep  4.0 ms · grep done");
	});

	it("stays bounded at compact width", () => {
		const lines = formatExecutionGraphLines(projection, 56);
		for (const line of lines) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(56);
		expect(lines.map(stripAnsi).join("\n")).toContain("agent review");
	});
});
