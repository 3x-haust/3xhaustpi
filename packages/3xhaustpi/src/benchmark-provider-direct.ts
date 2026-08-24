import { performance } from "node:perf_hooks";
import { parseProjectId } from "@3xhaust/semantic-contract";
import type { AssistantMessage, Context, ToolCall, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { compileSemanticOutput } from "../../core/src/index.ts";
import { totalInput, usageFields } from "./benchmark-provider-usage.ts";
import {
	type ArmSample,
	type BenchmarkCase,
	REAL_PROVIDER_TIMEOUT_MS,
	type RealBenchmarkContext,
} from "./benchmark-types.ts";
import { executeReadCapability, queryOf } from "./capability-executor.ts";

const DIRECT_TOOLS = {
	searchSymbol: {
		name: "searchSymbol",
		description: "Search the bounded project snapshot for one exact symbol.",
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) }),
	},
	searchText: {
		name: "searchText",
		description: "Search the bounded project snapshot for one exact text or error fingerprint.",
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) }),
	},
} as const;

function toolCall(message: AssistantMessage, benchmarkCase: BenchmarkCase): ToolCall {
	const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
	if (calls.length !== 1 || calls[0]?.name !== benchmarkCase.capability) {
		throw new Error(`Direct-tool arm did not produce exactly one ${benchmarkCase.capability} call`);
	}
	return calls[0];
}

function semanticTarget(benchmarkCase: BenchmarkCase) {
	if (benchmarkCase.targetKind === "symbol") return { kind: "symbol" as const, hint: benchmarkCase.query };
	if (benchmarkCase.targetKind === "error") return { kind: "error" as const, fingerprint: benchmarkCase.query };
	return { kind: "behavior" as const, description: benchmarkCase.query };
}

export async function directSample(
	benchmarkContext: RealBenchmarkContext,
	pair: number,
	benchmarkCase: BenchmarkCase,
): Promise<ArmSample> {
	const started = performance.now();
	let usage: Usage | undefined;
	let responseId: string | undefined;
	let modelOutputValid = false;
	let capabilityStarted = false;
	try {
		const context: Context = {
			systemPrompt: [
				"You are the direct-tool baseline for a paired coding benchmark.",
				"Call exactly one of the provided read tools with the exact capability and query named in the final user request.",
				"Do not answer with text before the tool call.",
			].join("\n"),
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: benchmarkContext.evidenceFor(benchmarkCase).text }],
					timestamp: 0,
				},
				{
					role: "user",
					content: [
						benchmarkCase.objective,
						`Case ${benchmarkCase.id}.`,
						`Required tool call: ${benchmarkCase.capability}(${JSON.stringify({ query: benchmarkCase.query })}).`,
					].join(" "),
					timestamp: 0,
				},
			],
			tools: [DIRECT_TOOLS.searchSymbol, DIRECT_TOOLS.searchText],
		};
		const message = await benchmarkContext.models.completeSimple(benchmarkContext.model, context, {
			signal: AbortSignal.timeout(REAL_PROVIDER_TIMEOUT_MS),
			cacheRetention: "long",
			sessionId: benchmarkContext.directSessionId(benchmarkCase),
			maxRetries: 0,
			maxTokens: 256,
		});
		usage = message.usage;
		responseId = message.responseId;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Provider stopped with ${message.stopReason}`);
		}
		const call = toolCall(message, benchmarkCase);
		modelOutputValid = true;
		const query = String(call.arguments.query ?? "");
		if (query !== benchmarkCase.query) {
			throw new Error(`Direct-tool query differed from the corpus contract: ${JSON.stringify(query)}`);
		}
		const synthetic = await compileSemanticOutput(
			{
				protocolVersion: 2,
				kind: "intent",
				payload: {
					kind: "inspect",
					objective: "Direct tool baseline",
					target: semanticTarget(benchmarkCase),
					evidenceGoals: ["Find exact symbol"],
					constraints: ["Read only"],
					doneWhen: "Exact symbol is found",
				},
			},
			{
				projectId: parseProjectId("prj_real_benchmark"),
				turnId: `turn_direct_${pair}`,
				projectRevision: "fixture_real_benchmark",
				observationDigests: [],
			},
		);
		if (synthetic.kind !== "readPlan" || synthetic.invocations.length !== 1) {
			throw new Error("Direct tool call did not compile to one read capability");
		}
		if (
			synthetic.invocations[0]!.capability !== benchmarkCase.capability ||
			queryOf(synthetic.invocations[0]!) !== benchmarkCase.query
		) {
			throw new Error("Direct tool call compiled to the wrong bounded capability");
		}
		capabilityStarted = true;
		const capabilityStartedAt = performance.now();
		const outcome = executeReadCapability(synthetic.invocations[0]!, benchmarkContext.projectRoot);
		const capabilityLatencyMs = performance.now() - capabilityStartedAt;
		return {
			arm: "direct-tool",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: outcome.status === "succeeded",
			latencyMs: performance.now() - started,
			...(responseId ? { responseId } : {}),
			...usageFields(usage),
			providerRequestInputTokens: [totalInput(usage)],
			providerRequestCacheReadTokens: [usage.cacheRead],
			modelOutputValid,
			providerRequests: 1,
			repairAttempts: 0,
			normalizationApplied: 0,
			capabilityStarted: 1,
			capabilityCompleted: 1,
			capabilitySucceeded: outcome.status === "succeeded" ? 1 : 0,
			capabilityLatencyMs,
		};
	} catch (error) {
		return {
			arm: "direct-tool",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: false,
			latencyMs: performance.now() - started,
			...(responseId ? { responseId } : {}),
			...(usage
				? usageFields(usage)
				: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
			providerRequestInputTokens: usage ? [totalInput(usage)] : [],
			providerRequestCacheReadTokens: usage ? [usage.cacheRead] : [],
			modelOutputValid,
			providerRequests: usage ? 1 : 0,
			repairAttempts: 0,
			normalizationApplied: 0,
			capabilityStarted: capabilityStarted ? 1 : 0,
			capabilityCompleted: capabilityStarted ? 1 : 0,
			capabilitySucceeded: 0,
			capabilityLatencyMs: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
