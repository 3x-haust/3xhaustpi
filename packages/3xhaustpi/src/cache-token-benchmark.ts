import { cacheBenchmarkSessionId, cleanupCacheBenchmarkSession } from "./cache-benchmark-provider.ts";
import { createCacheBenchmarkBaseReport, writeFinalCacheBenchmarkReport } from "./cache-benchmark-report.ts";
import { collectCacheBenchmarkSamples } from "./cache-benchmark-sampling.ts";
import { type CacheTokenBenchmarkOptions, DEFAULT_CACHE_BENCHMARK_OBJECTIVE } from "./cache-benchmark-types.ts";
import { createProjectSnapshot } from "./project-snapshot.ts";

export { summarizeCacheTokenSamples } from "./cache-benchmark-statistics.ts";
export type {
	CacheTokenBenchmarkOptions,
	CacheTokenProviderCall,
	CacheTokenSample,
} from "./cache-benchmark-types.ts";

export async function runCacheTokenBenchmark(options: CacheTokenBenchmarkOptions): Promise<unknown> {
	if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 20) {
		throw new Error("Cache-token benchmark requires at least 20 successful real-model samples");
	}
	const warmupCount = options.warmups ?? 2;
	const maximumAttempts = options.maximumAttempts ?? Math.max(options.repetitions, 100);
	const objective = options.objective ?? DEFAULT_CACHE_BENCHMARK_OBJECTIVE;
	const snapshot = createProjectSnapshot(options.projectRoot, objective);
	const baseReport = createCacheBenchmarkBaseReport(options, objective, maximumAttempts, snapshot);
	const providerSessionId = cacheBenchmarkSessionId(options, objective);
	try {
		const samples = await collectCacheBenchmarkSamples(options, objective, warmupCount, maximumAttempts, baseReport);
		const report = writeFinalCacheBenchmarkReport(options.artifactPath, baseReport, samples);
		if (!report.accepted) {
			throw new Error(`Cache-token benchmark acceptance failed; inspect ${options.artifactPath}`);
		}
		return report;
	} finally {
		cleanupCacheBenchmarkSession(providerSessionId);
	}
}
