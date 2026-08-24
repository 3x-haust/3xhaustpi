import { performance } from "node:perf_hooks";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { semanticProviderSessionId } from "../../pi-adapter/src/index.ts";
import type { CacheTokenBenchmarkOptions, CacheTokenProviderCall, CacheTokenSample } from "./cache-benchmark-types.ts";
import { type CodingTaskEvent, providerCacheSessionId, runCodingTask } from "./coding-runtime.ts";

type ModelCompletedEvent = Extract<CodingTaskEvent, { type: "model.completed" }>;
type CapabilityCompletedEvent = Extract<CodingTaskEvent, { type: "capability.completed" }>;

function providerCall(event: ModelCompletedEvent): CacheTokenProviderCall {
	if (event.usage.input === null || event.usage.output === null || event.usage.cacheRead === null) {
		throw new Error("Provider did not report complete cache-token usage");
	}
	const totalInputTokens = event.usage.input + event.usage.cacheRead;
	return {
		responseId: event.responseId,
		uncachedInputTokens: event.usage.input,
		cacheReadTokens: event.usage.cacheRead,
		totalInputTokens,
		cachedTokenRatio: totalInputTokens === 0 ? 0 : event.usage.cacheRead / totalInputTokens,
		outputTokens: event.usage.output,
		latencyMs: event.durationMs,
	};
}

const modelEvents = (events: readonly CodingTaskEvent[]): ModelCompletedEvent[] =>
	events.filter((event): event is ModelCompletedEvent => event.type === "model.completed");

const capabilityEvents = (events: readonly CodingTaskEvent[]): CapabilityCompletedEvent[] =>
	events.filter((event): event is CapabilityCompletedEvent => event.type === "capability.completed");

export async function executeCacheBenchmarkSample(
	options: CacheTokenBenchmarkOptions,
	objective: string,
	index: number,
	warmup: boolean,
): Promise<CacheTokenSample> {
	const events: CodingTaskEvent[] = [];
	const startedAt = performance.now();
	try {
		const result = await runCodingTask({
			projectRoot: options.projectRoot,
			objective,
			approve: false,
			statePath: ":memory:",
			provider: options.provider,
			model: options.model,
			sessionId: `session_cache_benchmark_${process.pid}_${warmup ? "warmup" : "sample"}_${index}`,
			onEvent: (event) => events.push(event),
		});
		const providerCalls = modelEvents(events).map(providerCall);
		const capabilities = capabilityEvents(events);
		const capabilityStarted = events.filter((event) => event.type === "capability.started").length;
		const capabilitySucceeded = capabilities.filter((event) => event.success).length;
		const success =
			result.outcome === "completed" &&
			result.decision === "completionSuggestion" &&
			providerCalls.length === 2 &&
			capabilityStarted === 1 &&
			capabilities.length === 1 &&
			capabilitySucceeded === 1;
		return {
			index,
			warmup,
			success,
			decision: result.decision,
			latencyMs: performance.now() - startedAt,
			providerCalls,
			capabilityStarted,
			capabilityCompleted: capabilities.length,
			capabilitySucceeded,
			capabilityLatencyMs: capabilities.reduce((sum, event) => sum + event.durationMs, 0),
			...(!success ? { error: "Task did not complete the exact two-turn read-capability contract" } : {}),
		};
	} catch (error) {
		const capabilities = capabilityEvents(events);
		return {
			index,
			warmup,
			success: false,
			latencyMs: performance.now() - startedAt,
			providerCalls: modelEvents(events).flatMap((event) => {
				if (event.usage.input === null || event.usage.output === null || event.usage.cacheRead === null) return [];
				return [providerCall(event)];
			}),
			capabilityStarted: events.filter((event) => event.type === "capability.started").length,
			capabilityCompleted: capabilities.length,
			capabilitySucceeded: capabilities.filter((event) => event.success).length,
			capabilityLatencyMs: capabilities.reduce((sum, event) => sum + event.durationMs, 0),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function cacheBenchmarkSessionId(options: CacheTokenBenchmarkOptions, objective: string): string {
	return providerCacheSessionId(options.projectRoot, options.provider, options.model, objective);
}

export function cleanupCacheBenchmarkSession(providerSessionId: string): void {
	for (const phase of ["initial", "followup"] as const) {
		cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase));
		cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase, true));
	}
}
