import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarkHash } from "./benchmark-provider-context.ts";
import type { RealBenchmarkSamplingResult } from "./benchmark-sampling.ts";
import { summarizeRealBenchmarkSamples } from "./benchmark-statistics.ts";
import { BENCHMARK_CASES, type RealBenchmarkContext, type RealBenchmarkOptions } from "./benchmark-types.ts";

export function writeRealBenchmarkReport(
	options: RealBenchmarkOptions,
	context: RealBenchmarkContext,
	result: RealBenchmarkSamplingResult,
): { readonly accepted: boolean; readonly artifactPath: string; readonly report: object } {
	const { warmups, attempts, samples, pairedSuccesses, maximumPairAttempts } = result;
	const semantic = samples.filter((sample) => sample.arm === "semantic-only");
	const direct = samples.filter((sample) => sample.arm === "direct-tool");
	const semanticSummary = summarizeRealBenchmarkSamples(semantic);
	const directSummary = summarizeRealBenchmarkSamples(direct);
	const caseResults = BENCHMARK_CASES.map((benchmarkCase) => {
		const caseSamples = samples.filter((sample) => sample.caseId === benchmarkCase.id);
		const caseAttempts = attempts.filter((sample) => sample.caseId === benchmarkCase.id);
		return {
			id: benchmarkCase.id,
			capability: benchmarkCase.capability,
			querySha256: benchmarkHash(benchmarkCase.query),
			evidenceCharacters: context.evidenceFor(benchmarkCase).text.length,
			evidenceSha256: context.evidenceFor(benchmarkCase).sha256,
			sampleCount: caseSamples.length,
			attemptCount: caseAttempts.length,
			semanticSuccesses: caseSamples.filter((sample) => sample.arm === "semantic-only" && sample.success).length,
			directSuccesses: caseSamples.filter((sample) => sample.arm === "direct-tool" && sample.success).length,
		};
	});
	const accepted =
		pairedSuccesses >= options.repetitions &&
		(semanticSummary.providerReportedWarmCacheHitRequestRate ?? 0) >= 0.98 &&
		(semanticSummary.providerReportedWarmCachedTokenRatio ?? 0) >= 0.98 &&
		(semanticSummary.capabilitySuccessRate ?? 0) >= 0.98 &&
		(semanticSummary.modelOutputValidityRate ?? 0) >= 0.98 &&
		semanticSummary.maxInputTokensPerRequest < 5_000 &&
		(directSummary.providerReportedWarmCacheHitRequestRate ?? 0) >= 0.98 &&
		(directSummary.capabilitySuccessRate ?? 0) >= 0.98 &&
		(directSummary.modelOutputValidityRate ?? 0) >= 0.98 &&
		directSummary.maxInputTokensPerRequest < 5_000;
	const report = {
		schemaVersion: 2,
		mode: "paired-real-provider",
		provider: context.provider,
		model: context.modelId,
		fixture: {
			projectRootHash: benchmarkHash(options.projectRoot),
			evidenceSha256: benchmarkHash(
				BENCHMARK_CASES.map((benchmarkCase) => context.evidenceFor(benchmarkCase).sha256).join("\0"),
			),
			evidenceFiles: context.evidenceFor(BENCHMARK_CASES[0]!).files,
			promptCharacterCount: Math.max(
				...BENCHMARK_CASES.map((benchmarkCase) => context.evidenceFor(benchmarkCase).text.length),
			),
			evidenceVariants: BENCHMARK_CASES.map((benchmarkCase) => ({
				caseId: benchmarkCase.id,
				characters: context.evidenceFor(benchmarkCase).text.length,
				sha256: context.evidenceFor(benchmarkCase).sha256,
			})),
		},
		corpus: { version: 1, caseCount: BENCHMARK_CASES.length, cases: caseResults },
		warmups,
		requiredPairedSuccesses: options.repetitions,
		maximumPairAttempts,
		pairAttempts: attempts.length / 2,
		pairedSuccesses,
		semanticOnly: semanticSummary,
		directTool: directSummary,
		coldInclusive: {
			semanticOnly: summarizeRealBenchmarkSamples([
				...warmups.filter((sample) => sample.arm === "semantic-only"),
				...semantic,
			]),
			directTool: summarizeRealBenchmarkSamples([
				...warmups.filter((sample) => sample.arm === "direct-tool"),
				...direct,
			]),
		},
		acceptance: {
			minimumPairedSuccesses: 20,
			minimumProviderReportedWarmCacheHitRequestRate: 0.98,
			minimumSemanticProviderReportedWarmCachedTokenRatio: 0.98,
			minimumCapabilitySuccessRate: 0.98,
			minimumModelOutputValidityRate: 0.98,
			maximumInputTokensPerRequest: 5_000,
		},
		accepted,
		attempts,
		samples,
	};
	const artifactDirectory = join(options.projectRoot, "artifacts", "real-llm");
	mkdirSync(artifactDirectory, { recursive: true });
	const artifactPath = join(artifactDirectory, `paired-${Date.now()}.json`);
	writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return { accepted, artifactPath, report };
}
