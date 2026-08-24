export type ExecutionNodeKind = "root" | "tool" | "agent";
export type ExecutionNodeState = "running" | "completed" | "failed";

export interface RunningExecutionNode {
	readonly id: string;
	readonly parentNodeId?: string;
	readonly kind: ExecutionNodeKind;
	readonly label: string;
	readonly state: "running";
}

export interface FinishedExecutionNode {
	readonly id: string;
	readonly parentNodeId?: string;
	readonly kind: ExecutionNodeKind;
	readonly label: string;
	readonly state: "completed" | "failed";
	readonly durationMs: number;
	readonly summary: string;
}

export type ExecutionNode = RunningExecutionNode | FinishedExecutionNode;

export interface ExecutionGraph {
	readonly runId: string;
	readonly nodes: readonly ExecutionNode[];
	readonly activeNodeIds: readonly string[];
}

export interface NodeStartedEvent {
	readonly type: "node.started";
	readonly nodeId: string;
	readonly parentNodeId?: string;
	readonly kind: ExecutionNodeKind;
	readonly label: string;
}

export interface NodeCompletedEvent {
	readonly type: "node.completed";
	readonly nodeId: string;
	readonly success: boolean;
	readonly durationMs: number;
	readonly summary: string;
}

export type ExecutionEvent = NodeStartedEvent | NodeCompletedEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`invalid execution ${field}`);
	return value;
}

function expectDuration(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("invalid execution durationMs");
	}
	return value;
}

function expectKind(value: unknown): ExecutionNodeKind {
	if (value !== "root" && value !== "tool" && value !== "agent") {
		throw new Error("invalid execution node kind");
	}
	return value;
}

function expectParentNodeId(value: unknown): string | undefined {
	return value === undefined ? undefined : expectString(value, "parentNodeId");
}

export function parseExecutionEvent(value: unknown): ExecutionEvent {
	if (!isRecord(value)) throw new Error("invalid execution event");
	if (value.type === "node.started") {
		return {
			type: "node.started",
			nodeId: expectString(value.nodeId, "nodeId"),
			...(value.parentNodeId === undefined ? {} : { parentNodeId: expectParentNodeId(value.parentNodeId) }),
			kind: expectKind(value.kind),
			label: expectString(value.label, "label"),
		};
	}
	if (value.type === "node.completed") {
		if (typeof value.success !== "boolean") throw new Error("invalid execution success");
		return {
			type: "node.completed",
			nodeId: expectString(value.nodeId, "nodeId"),
			success: value.success,
			durationMs: expectDuration(value.durationMs),
			summary: expectString(value.summary, "summary"),
		};
	}
	throw new Error("invalid execution event type");
}

function parseExecutionNode(value: unknown): ExecutionNode {
	if (!isRecord(value)) throw new Error("invalid execution node");
	const common = {
		id: expectString(value.id, "node ID"),
		...(value.parentNodeId === undefined ? {} : { parentNodeId: expectParentNodeId(value.parentNodeId) }),
		kind: expectKind(value.kind),
		label: expectString(value.label, "node label"),
	};
	if (value.state === "running") return { ...common, state: "running" };
	if (value.state !== "completed" && value.state !== "failed") {
		throw new Error("invalid execution node state");
	}
	return {
		...common,
		state: value.state,
		durationMs: expectDuration(value.durationMs),
		summary: expectString(value.summary, "summary"),
	};
}

export function parseExecutionGraphJson(serialized: string): ExecutionGraph {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("persisted execution graph is not valid JSON");
	}
	if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.activeNodeIds)) {
		throw new Error("persisted execution graph is invalid");
	}
	const runId = expectString(value.runId, "runId");
	const nodes = value.nodes.map(parseExecutionNode);
	const activeNodeIds = value.activeNodeIds.map((nodeId) => expectString(nodeId, "active node ID"));
	const seen = new Set<string>();
	for (const node of nodes) {
		if (seen.has(node.id)) throw new Error(`duplicate persisted execution node: ${node.id}`);
		if (node.parentNodeId !== undefined && !seen.has(node.parentNodeId)) {
			throw new Error(`unknown persisted parent execution node: ${node.parentNodeId}`);
		}
		seen.add(node.id);
	}
	const expectedActiveNodeIds = nodes.filter((node) => node.state === "running").map((node) => node.id);
	if (
		activeNodeIds.length !== expectedActiveNodeIds.length ||
		activeNodeIds.some((nodeId, index) => nodeId !== expectedActiveNodeIds[index])
	) {
		throw new Error("persisted execution active nodes are invalid");
	}
	return { runId, nodes, activeNodeIds };
}

export function createExecutionGraph(runId: string): ExecutionGraph {
	return {
		runId,
		nodes: [],
		activeNodeIds: [],
	};
}

function assertNever(event: never): never {
	throw new Error(`unsupported execution event: ${String(event)}`);
}

export function applyExecutionEvent(state: ExecutionGraph, event: ExecutionEvent): ExecutionGraph {
	switch (event.type) {
		case "node.started": {
			if (state.nodes.some((node) => node.id === event.nodeId)) {
				throw new Error(`duplicate execution node: ${event.nodeId}`);
			}
			if (event.parentNodeId && !state.nodes.some((node) => node.id === event.parentNodeId)) {
				throw new Error(`unknown parent execution node: ${event.parentNodeId}`);
			}

			const node: RunningExecutionNode = {
				id: event.nodeId,
				...(event.parentNodeId === undefined ? {} : { parentNodeId: event.parentNodeId }),
				kind: event.kind,
				label: event.label,
				state: "running",
			};

			return {
				...state,
				nodes: [...state.nodes, node],
				activeNodeIds: [...state.activeNodeIds, node.id],
			};
		}
		case "node.completed": {
			const nodeIndex = state.nodes.findIndex((node) => node.id === event.nodeId);
			if (nodeIndex === -1) {
				throw new Error(`unknown execution node: ${event.nodeId}`);
			}
			const current = state.nodes[nodeIndex];
			if (!current) throw new Error(`unknown execution node: ${event.nodeId}`);
			if (current.state !== "running") throw new Error(`execution node is already terminal: ${event.nodeId}`);

			const nodes = state.nodes.map((node, index): ExecutionNode => {
				if (index !== nodeIndex) return node;
				return {
					id: node.id,
					...(node.parentNodeId === undefined ? {} : { parentNodeId: node.parentNodeId }),
					kind: node.kind,
					label: node.label,
					state: event.success ? "completed" : "failed",
					durationMs: event.durationMs,
					summary: event.summary,
				};
			});

			return {
				...state,
				nodes,
				activeNodeIds: state.activeNodeIds.filter((nodeId) => nodeId !== event.nodeId),
			};
		}
		default:
			return assertNever(event);
	}
}
