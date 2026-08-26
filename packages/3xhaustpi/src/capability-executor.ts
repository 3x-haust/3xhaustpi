import type { CapabilityInvocation } from "../../core/src/index.ts";
import { searchProjectFiles } from "./project-files.ts";

export interface CapabilityExecution {
	readonly status: "succeeded" | "failed" | "timed-out";
	readonly summary: string;
	readonly matchCount: number;
	readonly outputHashInput: string;
	readonly executor?: "typescript" | "python";
	readonly cacheHit?: boolean;
}

const readCache = new Map<string, CapabilityExecution>();

export function clearReadCapabilityCache(): void {
	readCache.clear();
}

export function queryOf(invocation: CapabilityInvocation): string {
	const query = invocation.input.query;
	if (typeof query !== "string" || query.length === 0 || query.length > 512) {
		throw new Error(`${invocation.capability} requires a bounded string query`);
	}
	return query;
}

export function executeReadCapability(invocation: CapabilityInvocation, projectRoot: string): CapabilityExecution {
	if (invocation.effect !== "read" || invocation.policy.decision !== "allow") {
		return { status: "failed", summary: "Capability was not an allowed read", matchCount: 0, outputHashInput: "" };
	}
	if (invocation.capability !== "searchText" && invocation.capability !== "searchSymbol") {
		return {
			status: "failed",
			summary: `Benchmark executor does not support ${invocation.capability}`,
			matchCount: 0,
			outputHashInput: "",
		};
	}
	const cacheKey = JSON.stringify([
		projectRoot,
		invocation.capability,
		queryOf(invocation),
		invocation.basedOn.projectRevision,
	]);
	const cached = readCache.get(cacheKey);
	if (cached) return { ...cached, cacheHit: true };
	const result = searchProjectFiles(projectRoot, queryOf(invocation), invocation.timeoutMs);
	if (result.status === "timed-out") {
		return { status: "timed-out", summary: "Search timed out", matchCount: 0, outputHashInput: "" };
	}
	const lines = [...result.lines].sort((left, right) => left.localeCompare(right, "en")).slice(0, 200);
	const output = lines.join("\n");
	const matchCount = lines.length;
	const searchCompleted = result.status === "completed";
	const execution: CapabilityExecution = {
		status: searchCompleted ? "succeeded" : "failed",
		summary: searchCompleted
			? matchCount > 0
				? `Found ${matchCount} exact matches`
				: "Search completed with no exact matches"
			: `Search failed with exit code ${result.exitCode ?? "unknown"}`,
		matchCount,
		outputHashInput: output,
		executor: "typescript",
		cacheHit: false,
	};
	readCache.set(cacheKey, execution);
	if (readCache.size > 256) readCache.delete(readCache.keys().next().value!);
	return execution;
}
