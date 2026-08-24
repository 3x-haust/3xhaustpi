import type { CacheTokenSample } from "./cache-benchmark-types.ts";

export interface Distribution {
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
	const percentile = (ratio: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!;
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

export function summarizeCacheTokenSamples(samples: readonly CacheTokenSample[]) {
	const providerCalls = samples.flatMap((sample) => sample.providerCalls);
	const uncachedInputTokens = providerCalls.reduce((sum, call) => sum + call.uncachedInputTokens, 0);
	const cacheReadTokens = providerCalls.reduce((sum, call) => sum + call.cacheReadTokens, 0);
	const totalInputTokens = uncachedInputTokens + cacheReadTokens;
	const capabilityStarted = samples.reduce((sum, sample) => sum + sample.capabilityStarted, 0);
	const capabilityCompleted = samples.reduce((sum, sample) => sum + sample.capabilityCompleted, 0);
	const capabilitySucceeded = samples.reduce((sum, sample) => sum + sample.capabilitySucceeded, 0);
	const successfulSamples = samples.filter((sample) => sample.success).length;
	return {
		samples: samples.length,
		successfulSamples,
		failedSamples: samples.length - successfulSamples,
		taskSuccessRate: samples.length === 0 ? null : successfulSamples / samples.length,
		providerCalls: providerCalls.length,
		uncachedInputTokens,
		cacheReadTokens,
		totalInputTokens,
		providerReportedCachedTokenRatio: totalInputTokens === 0 ? null : cacheReadTokens / totalInputTokens,
		providerReportedCacheHitRequestRate:
			providerCalls.length === 0
				? null
				: providerCalls.filter((call) => call.cacheReadTokens > 0).length / providerCalls.length,
		capabilityStarted,
		capabilityCompleted,
		capabilitySucceeded,
		capabilitySuccessRate: capabilityStarted === 0 ? null : capabilitySucceeded / capabilityStarted,
		capabilityOrphanCount: Math.max(0, capabilityStarted - capabilityCompleted),
		latencyMs: distribution(samples.map((sample) => sample.latencyMs)),
		providerCallLatencyMs: distribution(providerCalls.map((call) => call.latencyMs)),
		capabilityLatencyMs: distribution(
			samples.filter((sample) => sample.capabilityCompleted > 0).map((sample) => sample.capabilityLatencyMs),
		),
	};
}

export function sampleCachedTokenRatio(sample: CacheTokenSample): number {
	const uncachedInputTokens = sample.providerCalls.reduce((sum, call) => sum + call.uncachedInputTokens, 0);
	const cacheReadTokens = sample.providerCalls.reduce((sum, call) => sum + call.cacheReadTokens, 0);
	const totalInputTokens = uncachedInputTokens + cacheReadTokens;
	return totalInputTokens === 0 ? 0 : cacheReadTokens / totalInputTokens;
}
