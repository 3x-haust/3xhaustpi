import { cleanupRealBenchmarkContext, createRealBenchmarkContext } from "./benchmark-provider-context.ts";
import { writeRealBenchmarkReport } from "./benchmark-report.ts";
import { collectRealBenchmarkSamples } from "./benchmark-sampling.ts";
import type { RealBenchmarkOptions } from "./benchmark-types.ts";

export { summarizeRealBenchmarkSamples } from "./benchmark-statistics.ts";
export type { ArmSample } from "./benchmark-types.ts";

export async function runRealBenchmark(options: RealBenchmarkOptions): Promise<void> {
	if (options.repetitions < 20) throw new Error("Real benchmark requires at least 20 paired samples");
	const context = await createRealBenchmarkContext(options);
	const samples = await collectRealBenchmarkSamples(context, options.repetitions);
	const { accepted, artifactPath, report } = writeRealBenchmarkReport(options, context, samples);
	cleanupRealBenchmarkContext(context);
	console.log(JSON.stringify({ ...report, attempts: undefined, samples: undefined, artifactPath }, null, 2));
	if (!accepted) throw new Error(`Real benchmark acceptance failed; inspect ${artifactPath}`);
}
