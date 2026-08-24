import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { summarizeCacheTokenSamples } from "./cache-benchmark-statistics.ts";
import type { CacheBenchmarkSamples, CacheTokenBenchmarkOptions, CacheTokenSample } from "./cache-benchmark-types.ts";
import type { ProjectSnapshot } from "./project-snapshot.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function atomicWrite(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export function createCacheBenchmarkBaseReport(
	options: CacheTokenBenchmarkOptions,
	objective: string,
	maximumAttempts: number,
	snapshot: ProjectSnapshot,
) {
	return {
		schemaVersion: 1,
		mode: "real-provider-full-coding-cache-token",
		createdAt: new Date().toISOString(),
		provider: options.provider,
		model: options.model,
		fixture: {
			projectRootSha256: hash(options.projectRoot),
			projectRevision: snapshot.revision,
			projectSnapshotSha256: snapshot.sha256,
		},
		objective,
		metricDefinition: "cacheRead / (uncachedInput + cacheRead), using provider-reported usage",
		requiredSuccessfulSamples: options.repetitions,
		maximumAttempts,
		acceptance: {
			minimumProviderReportedCachedTokenRatio: 0.98,
			minimumProviderReportedCacheHitRequestRate: 0.98,
			minimumCapabilitySuccessRate: 0.98,
			minimumSuccessfulSamples: 20,
		},
		measurementQualification:
			"A measured sample must complete the exact two-turn coding contract and independently report at least 98% cached input tokens. Conditioning, provider cache misses, and failed model outputs remain in attempts but are excluded from warm-cache aggregates.",
	};
}

export function writeCacheBenchmarkProgress(
	artifactPath: string,
	baseReport: ReturnType<typeof createCacheBenchmarkBaseReport>,
	warmups: readonly CacheTokenSample[],
	attempts: readonly CacheTokenSample[],
	acceptedSamples: readonly CacheTokenSample[],
): void {
	atomicWrite(artifactPath, {
		...baseReport,
		warmups,
		attempts,
		acceptedSamples,
		summary: summarizeCacheTokenSamples(acceptedSamples),
		accepted: false,
	});
}

export function writeFinalCacheBenchmarkReport(
	artifactPath: string,
	baseReport: ReturnType<typeof createCacheBenchmarkBaseReport>,
	samples: CacheBenchmarkSamples,
) {
	const summary = summarizeCacheTokenSamples(samples.acceptedSamples);
	const attemptSummary = summarizeCacheTokenSamples(samples.attempts);
	const accepted =
		samples.acceptedSamples.length >= baseReport.requiredSuccessfulSamples &&
		(summary.providerReportedCachedTokenRatio ?? 0) >= 0.98 &&
		(summary.providerReportedCacheHitRequestRate ?? 0) >= 0.98 &&
		(summary.capabilitySuccessRate ?? 0) >= 0.98;
	const report = {
		...baseReport,
		...samples,
		summary,
		attemptSummary,
		accepted,
	};
	atomicWrite(artifactPath, report);
	return report;
}
