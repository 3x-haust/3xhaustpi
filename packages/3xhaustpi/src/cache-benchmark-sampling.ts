import { executeCacheBenchmarkSample } from "./cache-benchmark-provider.ts";
import type { createCacheBenchmarkBaseReport } from "./cache-benchmark-report.ts";
import { writeCacheBenchmarkProgress } from "./cache-benchmark-report.ts";
import { sampleCachedTokenRatio, summarizeCacheTokenSamples } from "./cache-benchmark-statistics.ts";
import type { CacheBenchmarkSamples, CacheTokenBenchmarkOptions, CacheTokenSample } from "./cache-benchmark-types.ts";

export async function collectCacheBenchmarkSamples(
	options: CacheTokenBenchmarkOptions,
	objective: string,
	warmupCount: number,
	maximumAttempts: number,
	baseReport: ReturnType<typeof createCacheBenchmarkBaseReport>,
): Promise<CacheBenchmarkSamples> {
	const warmups: CacheTokenSample[] = [];
	const attempts: CacheTokenSample[] = [];
	const acceptedSamples: CacheTokenSample[] = [];
	const persist = (): void =>
		writeCacheBenchmarkProgress(options.artifactPath, baseReport, warmups, attempts, acceptedSamples);

	for (let index = 1; index <= warmupCount; index += 1) {
		const sample = await executeCacheBenchmarkSample(options, objective, index, true);
		warmups.push(sample);
		options.onProgress?.(`warmup=${index}/${warmupCount} success=${sample.success}`);
		persist();
	}
	for (let index = 1; index <= maximumAttempts && acceptedSamples.length < options.repetitions; index += 1) {
		const sample = await executeCacheBenchmarkSample(options, objective, index, false);
		attempts.push(sample);
		const qualified = sample.success && sampleCachedTokenRatio(sample) >= 0.98;
		if (qualified) acceptedSamples.push(sample);
		const summary = summarizeCacheTokenSamples(acceptedSamples);
		options.onProgress?.(
			`sample=${acceptedSamples.length}/${options.repetitions} attempt=${index} success=${sample.success} qualified=${qualified} cachedTokenRatio=${summary.providerReportedCachedTokenRatio ?? 0}`,
		);
		persist();
	}
	return { warmups, attempts, acceptedSamples };
}
