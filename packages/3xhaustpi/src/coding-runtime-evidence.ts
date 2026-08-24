import { normalizeObservation } from "../../core/src/index.ts";
import { executeReadCapability } from "./capability-executor.ts";
import { digest } from "./coding-runtime-provider.ts";
import type { ProjectDocument } from "./project-snapshot.ts";
import type { PythonReadPool } from "./python-read-pool.ts";

async function executeTaskReadCapability(
	invocation: Parameters<typeof executeReadCapability>[0],
	projectRoot: string,
	documents: ReadonlyMap<string, ProjectDocument>,
	pythonPool?: PythonReadPool,
) {
	if (pythonPool && (invocation.capability === "searchText" || invocation.capability === "searchSymbol")) {
		try {
			return await pythonPool.execute(invocation, projectRoot);
		} catch {
			return executeReadCapability(invocation, projectRoot);
		}
	}
	if (invocation.capability !== "readRanges") return executeReadCapability(invocation, projectRoot);
	if (invocation.policy.decision !== "allow") {
		return { status: "failed" as const, summary: "readRanges was denied", matchCount: 0, outputHashInput: "" };
	}
	const requested = Array.isArray(invocation.input.documentIds)
		? invocation.input.documentIds.filter((id): id is string => typeof id === "string")
		: [];
	const selected = requested.filter((id) => documents.has(id));
	return {
		status: selected.length > 0 ? ("succeeded" as const) : ("failed" as const),
		summary: selected.length > 0 ? `Read ${selected.length} disclosed documents` : "No disclosed documents matched",
		matchCount: selected.length,
		outputHashInput: selected.map((id) => documents.get(id)?.sha256 ?? "").join("\n"),
	};
}

export interface ReadPlanEventSink {
	readonly onStarted: (
		capability: "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics",
	) => void;
	readonly onCompleted: (event: {
		readonly type: "capability.completed";
		readonly capability: "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics";
		readonly success: boolean;
		readonly durationMs: number;
		readonly summary: string;
	}) => void;
}

/**
 * Executes every planned read capability concurrently (bounded by the caller's
 * slice) so total wall time tracks the slowest read, then normalizes one
 * observation per invocation in input order.
 */
export async function executeReadPlanInvocations(
	invocations: readonly Parameters<typeof executeTaskReadCapability>[0][],
	context: {
		readonly projectRoot: string;
		documents: ReadonlyMap<string, ProjectDocument>;
		pythonPool?: PythonReadPool;
		readonly onStarted?: ReadPlanEventSink["onStarted"];
		readonly onCompleted?: ReadPlanEventSink["onCompleted"];
	},
) {
	const outcomes = await Promise.all(
		invocations.map(async (invocation) => {
			context.onStarted?.(invocation.capability);
			const started = performance.now();
			const outcome = await executeTaskReadCapability(
				invocation,
				context.projectRoot,
				context.documents,
				context.pythonPool,
			);
			context.onCompleted?.({
				type: "capability.completed",
				capability: invocation.capability,
				success: outcome.status === "succeeded",
				durationMs: performance.now() - started,
				summary: outcome.summary,
			});
			return { invocation, outcome };
		}),
	);
	return Promise.all(
		outcomes.map(({ invocation, outcome }) =>
			normalizeObservation(invocation, {
				status: outcome.status,
				summary: outcome.summary,
				facts: { matchCount: outcome.matchCount, outputSha256: digest(outcome.outputHashInput) },
				artifactRefs: [],
			}),
		),
	);
}
