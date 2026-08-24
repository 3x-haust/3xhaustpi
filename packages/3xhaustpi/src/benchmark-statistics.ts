import type { ArmSample } from "./benchmark-types.ts";

interface Distribution {
	readonly count: number;
	readonly mean: number | null;
	readonly p50: number | null;
	readonly p95: number | null;
	readonly minimum: number | null;
	readonly maximum: number | null;
	readonly coefficientOfVariation: number | null;
}

function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) {
		return {
			count: 0,
			mean: null,
			p50: null,
			p95: null,
			minimum: null,
			maximum: null,
			coefficientOfVariation: null,
		};
	}
	const sorted = [...values].sort((left, right) => left - right);
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
	const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!;
	return {
		count: values.length,
		mean,
		p50: percentile(0.5),
		p95: percentile(0.95),
		minimum: sorted[0]!,
		maximum: sorted.at(-1)!,
		coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
	};
}

export function summarizeRealBenchmarkSamples(samples: readonly ArmSample[]) {
	const uncachedInputTokens = samples.reduce((sum, sample) => sum + sample.uncachedInputTokens, 0);
	const cacheReadTokens = samples.reduce((sum, sample) => sum + sample.cacheReadTokens, 0);
	const cacheWriteTokens = samples.reduce((sum, sample) => sum + sample.cacheWriteTokens, 0);
	const totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
	const providerRequestCacheReadTokens = samples.flatMap((sample) => sample.providerRequestCacheReadTokens);
	const started = samples.reduce((sum, sample) => sum + sample.capabilityStarted, 0);
	const completed = samples.reduce((sum, sample) => sum + sample.capabilityCompleted, 0);
	const succeeded = samples.reduce((sum, sample) => sum + sample.capabilitySucceeded, 0);
	const successes = samples.filter((sample) => sample.success).length;
	const latency = distribution(samples.map((sample) => sample.latencyMs));
	const capabilityLatency = distribution(
		samples.filter((sample) => sample.capabilityCompleted > 0).map((sample) => sample.capabilityLatencyMs),
	);
	const totalLatencyMs = samples.reduce((sum, sample) => sum + sample.latencyMs, 0);
	const repairAttempts = samples.reduce((sum, sample) => sum + sample.repairAttempts, 0);
	const normalizationAttempts = samples.reduce((sum, sample) => sum + sample.normalizationApplied, 0);
	return {
		requests: samples.length,
		successes,
		failures: samples.length - successes,
		timeoutCount: samples.filter((sample) => /timeout|timed out/iu.test(sample.error ?? "")).length,
		uncachedInputTokens,
		totalInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		providerReportedWarmCacheHitRequestRate:
			providerRequestCacheReadTokens.length === 0
				? null
				: providerRequestCacheReadTokens.filter((tokens) => tokens > 0).length /
					providerRequestCacheReadTokens.length,
		providerReportedWarmCachedTokenRatio: totalInputTokens === 0 ? null : cacheReadTokens / totalInputTokens,
		providerRequestCount: providerRequestCacheReadTokens.length,
		maxInputTokensPerRequest: Math.max(0, ...samples.flatMap((sample) => sample.providerRequestInputTokens)),
		modelOutputValidityRate:
			samples.length === 0 ? null : samples.filter((sample) => sample.modelOutputValid).length / samples.length,
		providerRequests: samples.reduce((sum, sample) => sum + sample.providerRequests, 0),
		repairAttempts,
		repairRate:
			samples.length === 0 ? null : samples.filter((sample) => sample.repairAttempts > 0).length / samples.length,
		normalizationAttempts,
		normalizationRate: samples.length === 0 ? null : normalizationAttempts / samples.length,
		capabilityStarted: started,
		capabilityCompleted: completed,
		capabilitySucceeded: succeeded,
		capabilitySuccessRate: started === 0 ? null : succeeded / started,
		capabilityOrphanCount: Math.max(0, started - completed),
		latencyMs: latency,
		capabilityLatencyMs: capabilityLatency,
		throughputPerMinute: totalLatencyMs === 0 ? null : (successes * 60_000) / totalLatencyMs,
	};
}
