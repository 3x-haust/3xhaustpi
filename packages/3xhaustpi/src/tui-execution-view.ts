import type { ExecutionNode } from "./execution-graph.ts";
import type { TuiExecutionProjection } from "./state.ts";
import { accent, ellipsizeCells, failure, muted, sanitizeTerminalText, success, text } from "./tui-text.ts";

function graphField(value: string): string {
	return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function nodeSymbol(node: ExecutionNode): string {
	switch (node.state) {
		case "running":
			return accent("•");
		case "completed":
			return success("✓");
		case "failed":
			return failure("×");
	}
}

function nodeLabel(node: ExecutionNode): string {
	const label = graphField(node.label);
	return node.kind === "agent" ? `agent ${label}` : label;
}

function nodeDetail(node: ExecutionNode): string {
	if (node.state === "running") return "";
	return `  ${node.durationMs.toFixed(1)} ms · ${graphField(node.summary)}`;
}

export function formatExecutionGraphLines(projection: TuiExecutionProjection, columns: number): string[] {
	const width = Math.max(1, Math.floor(columns));
	const workNodes = projection.graph.nodes.filter((node) => node.kind !== "root");
	const active = workNodes.filter((node) => node.state === "running").length;
	const done = workNodes.filter((node) => node.state === "completed").length;
	const failed = workNodes.filter((node) => node.state === "failed").length;
	const counts = [
		active > 0 ? `${active} active node${active === 1 ? "" : "s"}` : undefined,
		done > 0 ? `${done} completed node${done === 1 ? "" : "s"}` : undefined,
		failed > 0 ? `${failed} failed node${failed === 1 ? "" : "s"}` : undefined,
	]
		.filter((value) => value !== undefined)
		.join(" · ");
	const header = ellipsizeCells(
		`${text("Work graph")} ${muted(
			`· ${projection.status}${counts ? ` · ${counts}` : ""} · ${graphField(projection.objective)}`,
		)}`,
		width,
	);
	const childrenByParent = new Map<string, ExecutionNode[]>();
	for (const node of projection.graph.nodes) {
		if (!node.parentNodeId) continue;
		const siblings = childrenByParent.get(node.parentNodeId) ?? [];
		siblings.push(node);
		childrenByParent.set(node.parentNodeId, siblings);
	}
	const rows: string[] = [];
	const appendChildren = (parentNodeId: string, prefix: string) => {
		const children = childrenByParent.get(parentNodeId) ?? [];
		children.forEach((node, index) => {
			const isLast = index === children.length - 1;
			const connector = isLast ? "└─" : "├─";
			rows.push(
				ellipsizeCells(
					`${prefix}${connector} ${nodeSymbol(node)} ${text(nodeLabel(node))}${muted(nodeDetail(node))}`,
					width,
				),
			);
			appendChildren(node.id, `${prefix}${isLast ? "   " : "│  "}`);
		});
	};
	appendChildren(projection.requestId, "");
	if (rows.length === 0) return [header, muted("No child work.")];
	return [header, ...rows];
}
