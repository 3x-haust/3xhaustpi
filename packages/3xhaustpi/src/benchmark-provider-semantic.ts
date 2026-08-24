import { performance } from "node:perf_hooks";
import { parseProjectId, parseSemanticTurnRequest } from "@3xhaust/semantic-contract";
import type { Usage } from "@earendil-works/pi-ai";
import { compileSemanticOutput } from "../../core/src/index.ts";
import { createThreeXhaustPiAdapter } from "../../pi-adapter/src/index.ts";
import { aggregateUsage, totalInput } from "./benchmark-provider-usage.ts";
import {
	type ArmSample,
	type BenchmarkCase,
	REAL_PROVIDER_TIMEOUT_MS,
	type RealBenchmarkContext,
} from "./benchmark-types.ts";
import { executeReadCapability, queryOf } from "./capability-executor.ts";

export async function semanticSample(
	context: RealBenchmarkContext,
	pair: number,
	benchmarkCase: BenchmarkCase,
): Promise<ArmSample> {
	const started = performance.now();
	const usages: Usage[] = [];
	let responseId: string | undefined;
	let modelOutputValid = false;
	let normalizationApplied = 0;
	try {
		const adapter = createThreeXhaustPiAdapter({
			complete: async (requestModel, requestContext, options) => {
				const message = await context.models.completeSimple(requestModel, requestContext, options);
				usages.push(message.usage);
				responseId = message.responseId;
				return message;
			},
		});
		const session = adapter.open({
			connectionId: "connection_real_benchmark",
			model: context.model,
			sessionId: context.semanticSessionId(benchmarkCase),
			cacheRetention: "long",
			cacheUsageSupport: { read: "reported", write: "reported" },
			stableContext: context.evidenceFor(benchmarkCase).text,
			maxTokens: 512,
		});
		const result = await session.submit(
			parseSemanticTurnRequest({
				protocolVersion: 2,
				mode: "prompt",
				objective: benchmarkCase.objective,
				disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
			}),
			AbortSignal.timeout(REAL_PROVIDER_TIMEOUT_MS),
		);
		await session.close();
		modelOutputValid = true;
		normalizationApplied = result.normalization === "none" ? 0 : 1;
		const recipe = await compileSemanticOutput(result.output, {
			projectId: parseProjectId("prj_real_benchmark"),
			turnId: `turn_semantic_${pair}`,
			projectRevision: "fixture_real_benchmark",
			observationDigests: [],
		});
		if (recipe.kind !== "readPlan" || recipe.invocations.length !== 1) {
			throw new Error(`Semantic output compiled to ${recipe.kind}, not one read capability`);
		}
		if (
			recipe.invocations[0]!.capability !== benchmarkCase.capability ||
			queryOf(recipe.invocations[0]!) !== benchmarkCase.query
		) {
			throw new Error(
				`Semantic output violated corpus contract for ${benchmarkCase.id}: ${recipe.invocations[0]!.capability}`,
			);
		}
		const capabilityStartedAt = performance.now();
		const outcome = executeReadCapability(recipe.invocations[0]!, context.projectRoot);
		const capabilityLatencyMs = performance.now() - capabilityStartedAt;
		return {
			arm: "semantic-only",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: outcome.status === "succeeded",
			latencyMs: performance.now() - started,
			...(result.responseId ? { responseId: result.responseId } : {}),
			...aggregateUsage(usages),
			providerRequestInputTokens: usages.map(totalInput),
			providerRequestCacheReadTokens: usages.map((usage) => usage.cacheRead),
			modelOutputValid,
			providerRequests: usages.length,
			repairAttempts: Math.max(0, usages.length - 1),
			normalizationApplied,
			capabilityStarted: 1,
			capabilityCompleted: 1,
			capabilitySucceeded: outcome.status === "succeeded" ? 1 : 0,
			capabilityLatencyMs,
		};
	} catch (error) {
		return {
			arm: "semantic-only",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: false,
			latencyMs: performance.now() - started,
			...(responseId ? { responseId } : {}),
			...aggregateUsage(usages),
			providerRequestInputTokens: usages.map(totalInput),
			providerRequestCacheReadTokens: usages.map((usage) => usage.cacheRead),
			modelOutputValid,
			providerRequests: usages.length,
			repairAttempts: Math.max(0, usages.length - 1),
			normalizationApplied,
			capabilityStarted: 0,
			capabilityCompleted: 0,
			capabilitySucceeded: 0,
			capabilityLatencyMs: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
