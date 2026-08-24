export interface CacheTokenBenchmarkOptions {
	readonly projectRoot: string;
	readonly artifactPath: string;
	readonly repetitions: number;
	readonly warmups?: number;
	readonly provider: string;
	readonly model: string;
	readonly objective?: string;
	readonly maximumAttempts?: number;
	readonly onProgress?: (message: string) => void;
}

export interface CacheTokenProviderCall {
	readonly responseId: string;
	readonly uncachedInputTokens: number;
	readonly cacheReadTokens: number;
	readonly totalInputTokens: number;
	readonly cachedTokenRatio: number;
	readonly outputTokens: number;
	readonly latencyMs: number;
}

export interface CacheTokenSample {
	readonly index: number;
	readonly warmup: boolean;
	readonly success: boolean;
	readonly decision?: string;
	readonly latencyMs: number;
	readonly providerCalls: readonly CacheTokenProviderCall[];
	readonly capabilityStarted: number;
	readonly capabilityCompleted: number;
	readonly capabilitySucceeded: number;
	readonly capabilityLatencyMs: number;
	readonly error?: string;
}

export interface CacheBenchmarkSamples {
	readonly warmups: readonly CacheTokenSample[];
	readonly attempts: readonly CacheTokenSample[];
	readonly acceptedSamples: readonly CacheTokenSample[];
}

export const DEFAULT_CACHE_BENCHMARK_OBJECTIVE =
	"Inspect exact symbol createStaticServer; then complete from the observation.";
