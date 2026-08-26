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
		expect(lines[0]).toContain("1 active node");
		expect(lines[0]).toContain("2 completed nodes");
		expect(lines).toContain("├─ ✓ read  12.5 ms · read done");
		expect(lines).toContain("└─ • agent review");
		expect(lines).toContain("   └─ ✓ grep  4.0 ms · grep done");
	});

	it("stays bounded at compact width", () => {
		const lines = formatExecutionGraphLines(projection, 56);
		for (const line of lines) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(56);
		expect(lines.map(stripAnsi).join("\n")).toContain("agent review");
	});

	it("sanitizes dynamic graph fields into bounded physical rows", () => {
		// Given: persisted objective, label, and summary fields with CJK and terminal controls.
		const unsafe: TuiExecutionProjection = {
			...projection,
			objective: "인증 조사\u001b[2J\n다음 줄",
			graph: {
				...projection.graph,
				nodes: projection.graph.nodes.map((node) =>
					node.id === "call_read"
						? {
								...node,
								label: "읽기\u001b]52;c;Y2xpcA==\u0007\n보조",
								summary: "완료\u001b[31m\n추가",
							}
						: node,
				),
			},
		};

		// When: the execution graph is formatted for a compact terminal.
		const lines = formatExecutionGraphLines(unsafe, 120);

		// Then: controls and embedded rows are removed without breaking CJK bounds.
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(lines.join("")).not.toContain("\u001b]52");
		expect(lines.join("")).not.toContain("\u001b[2J");
		expect(lines.map(stripAnsi).join("\n")).toContain("인증 조사 다");
		expect(lines.map(stripAnsi).join("\n")).toContain("읽기 보조");
		for (const line of lines) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(120);
	});
});
