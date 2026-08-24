import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { StableProjectEvidence } from "./project-evidence.ts";

export interface RealBenchmarkOptions {
	readonly projectRoot: string;
	readonly repetitions: number;
	readonly provider?: string;
	readonly model?: string;
}

export interface ArmSample {
	readonly arm: "semantic-only" | "direct-tool";
	readonly pair: number;
	readonly caseId: string;
	readonly expectedCapability: "searchText" | "searchSymbol";
	readonly success: boolean;
	readonly latencyMs: number;
	readonly responseId?: string;
	readonly uncachedInputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly providerRequestInputTokens: readonly number[];
	readonly providerRequestCacheReadTokens: readonly number[];
	readonly modelOutputValid: boolean;
	readonly providerRequests: number;
	readonly repairAttempts: number;
	readonly normalizationApplied: number;
	readonly capabilityStarted: number;
	readonly capabilityCompleted: number;
	readonly capabilitySucceeded: number;
	readonly capabilityLatencyMs: number;
	readonly error?: string;
}

export interface BenchmarkCase {
	readonly id: string;
	readonly capability: "searchText" | "searchSymbol";
	readonly query: string;
	readonly targetKind: "symbol" | "behavior" | "error";
	readonly objective: string;
	readonly evidenceCharacters: number;
}

export interface RealBenchmarkContext {
	readonly models: Models;
	readonly model: Model<Api>;
	readonly provider: string;
	readonly modelId: string;
	readonly projectRoot: string;
	readonly evidenceFor: (benchmarkCase: BenchmarkCase) => StableProjectEvidence;
	readonly semanticSessionId: (benchmarkCase: BenchmarkCase) => string;
	readonly directSessionId: (benchmarkCase: BenchmarkCase) => string;
}

export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
	{
		id: "semantic-prefix-symbol",
		capability: "searchSymbol",
		query: "X3HAUST_SEMANTIC_STABLE_PREFIX",
		targetKind: "symbol",
		objective: 'Return inspect for {"kind":"symbol","hint":"X3HAUST_SEMANTIC_STABLE_PREFIX"}.',
		evidenceCharacters: 16_284,
	},
	{
		id: "policy-denial-text",
		capability: "searchText",
		query: "workspace writes are disabled",
		targetKind: "behavior",
		objective: 'Return inspect for {"kind":"behavior","description":"workspace writes are disabled"}.',
		evidenceCharacters: 16_316,
	},
	{
		id: "stale-generation-error",
		capability: "searchText",
		query: "Provider outbox generation is stale",
		targetKind: "error",
		objective: 'Return inspect for {"kind":"error","fingerprint":"Provider outbox generation is stale"}.',
		evidenceCharacters: 16_308,
	},
	{
		id: "policy-version-symbol",
		capability: "searchSymbol",
		query: "POLICY_VERSION",
		targetKind: "symbol",
		objective: 'Return inspect for {"kind":"symbol","hint":"POLICY_VERSION"}.',
		evidenceCharacters: 16_328,
	},
	{
		id: "completion-claim-text",
		capability: "searchText",
		query: "CompleteIntent claims must be non-empty",
		targetKind: "behavior",
		objective: 'Return inspect for {"kind":"behavior","description":"CompleteIntent claims must be non-empty"}.',
		evidenceCharacters: 16_296,
	},
] as const;

export const REAL_PROVIDER_TIMEOUT_MS = 45_000;
