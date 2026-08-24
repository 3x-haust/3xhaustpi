import type { ExecutionNode } from "./execution-graph.ts";
import type { TuiExecutionProjection } from "./state.ts";
import { accent, ellipsizeCells, failure, muted, success, text } from "./tui-text.ts";

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
	return node.kind === "agent" ? `agent ${node.label}` : node.label;
}

function nodeDetail(node: ExecutionNode): string {
	if (node.state === "running") return "";
	return `  ${node.durationMs.toFixed(1)} ms · ${node.summary}`;
}

export function formatExecutionGraphLines(projection: TuiExecutionProjection, columns: number): string[] {
	const width = Math.max(1, Math.floor(columns));
	const active = projection.graph.activeNodeIds.length;
	const done = projection.graph.nodes.filter((node) => node.state === "completed").length;
	const failed = projection.graph.nodes.filter((node) => node.state === "failed").length;
	const counts = [
		active > 0 ? `${active} active` : undefined,
		done > 0 ? `${done} done` : undefined,
		failed > 0 ? `${failed} failed` : undefined,
	]
		.filter((value) => value !== undefined)
		.join(" · ");
	const header = ellipsizeCells(
		`${text("Work graph")} ${muted(`· ${projection.status}${counts ? ` · ${counts}` : ""} · ${projection.objective}`)}`,
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
