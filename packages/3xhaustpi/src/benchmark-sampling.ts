import { directSample } from "./benchmark-provider-direct.ts";
import { semanticSample } from "./benchmark-provider-semantic.ts";
import { type ArmSample, BENCHMARK_CASES, type BenchmarkCase, type RealBenchmarkContext } from "./benchmark-types.ts";

export interface RealBenchmarkSamplingResult {
	readonly warmups: readonly ArmSample[];
	readonly attempts: readonly ArmSample[];
	readonly samples: readonly ArmSample[];
	readonly pairedSuccesses: number;
	readonly maximumPairAttempts: number;
}

type SampleExecution = () => Promise<ArmSample>;

function orderedExecutions(
	context: RealBenchmarkContext,
	benchmarkCase: BenchmarkCase,
	pair: number,
	semanticFirst: boolean,
): readonly SampleExecution[] {
	const semantic = () => semanticSample(context, pair, benchmarkCase);
	const direct = () => directSample(context, pair, benchmarkCase);
	return semanticFirst ? [semantic, direct] : [direct, semantic];
}

async function collect(executions: readonly SampleExecution[]): Promise<ArmSample[]> {
	const collected: ArmSample[] = [];
	for (const execute of executions) collected.push(await execute());
	return collected;
}

function qualifies(pairSamples: readonly ArmSample[]): boolean {
	const semantic = pairSamples.find((sample) => sample.arm === "semantic-only");
	const direct = pairSamples.find((sample) => sample.arm === "direct-tool");
	const semanticInput = semantic
		? semantic.uncachedInputTokens + semantic.cacheReadTokens + semantic.cacheWriteTokens
		: Number.POSITIVE_INFINITY;
	const directInput = direct
		? direct.uncachedInputTokens + direct.cacheReadTokens + direct.cacheWriteTokens
		: Number.POSITIVE_INFINITY;
	const semanticCachedTokenRatio = semantic ? semantic.cacheReadTokens / semanticInput : 0;
	return Boolean(
		semantic?.success &&
			direct?.success &&
			semantic.cacheReadTokens > 0 &&
			direct.cacheReadTokens > 0 &&
			semanticCachedTokenRatio >= 0.98 &&
			semanticInput < 5_000 &&
			directInput < 5_000,
	);
}

export async function collectRealBenchmarkSamples(
	context: RealBenchmarkContext,
	repetitions: number,
): Promise<RealBenchmarkSamplingResult> {
	const warmups: ArmSample[] = [];
	for (let warmupRound = 0; warmupRound < 2; warmupRound += 1) {
		for (const [caseIndex, benchmarkCase] of BENCHMARK_CASES.entries()) {
			const warmupIndex = warmupRound * BENCHMARK_CASES.length + caseIndex;
			const warmupPair = -(warmupIndex + 1);
			warmups.push(...(await collect(orderedExecutions(context, benchmarkCase, warmupPair, warmupIndex % 2 === 0))));
		}
	}
	const attempts: ArmSample[] = [];
	const samples: ArmSample[] = [];
	const maximumPairAttempts = repetitions * 2;
	let pairedSuccesses = 0;
	for (let pair = 1; pair <= maximumPairAttempts && pairedSuccesses < repetitions; pair += 1) {
		const benchmarkCase = BENCHMARK_CASES[(pair - 1) % BENCHMARK_CASES.length]!;
		const pairSamples = await collect(orderedExecutions(context, benchmarkCase, pair, pair % 2 !== 0));
		for (const sample of pairSamples) {
			attempts.push(sample);
			console.error(
				`${sample.arm} pair=${pair} case=${sample.caseId} success=${sample.success} cache=${sample.cacheReadTokens}/${
					sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
				}${sample.error ? ` error=${sample.error}` : ""}`,
			);
		}
		if (qualifies(pairSamples)) {
			samples.push(...pairSamples);
			pairedSuccesses += 1;
		}
	}
	return { warmups, attempts, samples, pairedSuccesses, maximumPairAttempts };
}
