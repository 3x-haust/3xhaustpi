import { createHash } from "node:crypto";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { semanticProviderSessionId, X3HAUST_SEMANTIC_STABLE_PREFIX } from "../../pi-adapter/src/index.ts";
import {
	BENCHMARK_CASES,
	type BenchmarkCase,
	type RealBenchmarkContext,
	type RealBenchmarkOptions,
} from "./benchmark-types.ts";
import { createStableProjectEvidence } from "./project-evidence.ts";
import { createProviderRuntime, DEFAULT_MODEL, DEFAULT_PROVIDER, resolveModel } from "./provider-runtime.ts";

export const benchmarkHash = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function createRealBenchmarkContext(options: RealBenchmarkOptions): Promise<RealBenchmarkContext> {
	const models = createProviderRuntime();
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const modelId = options.model ?? DEFAULT_MODEL;
	if (!(await models.checkAuth(provider))) throw new Error(`Provider is not authenticated: ${provider}`);
	const model = resolveModel(models, provider, modelId);
	const evidenceByCase = new Map(
		BENCHMARK_CASES.map((benchmarkCase) => [
			benchmarkCase.id,
			createStableProjectEvidence(options.projectRoot, benchmarkCase.evidenceCharacters),
		]),
	);
	const evidenceFor = (benchmarkCase: BenchmarkCase) => {
		const evidence = evidenceByCase.get(benchmarkCase.id);
		if (!evidence) throw new Error(`Missing evidence variant for ${benchmarkCase.id}`);
		return evidence;
	};
	const semanticSessionId = (benchmarkCase: BenchmarkCase): string =>
		`3xhaustpi-semantic-${benchmarkHash(`${X3HAUST_SEMANTIC_STABLE_PREFIX}\0${evidenceFor(benchmarkCase).sha256}\0${benchmarkCase.id}`).slice(0, 24)}`;
	const directSessionId = (benchmarkCase: BenchmarkCase): string =>
		`3xhaustpi-direct-${benchmarkHash(`${evidenceFor(benchmarkCase).sha256}\0${benchmarkCase.id}`).slice(0, 24)}`;
	return {
		models,
		model,
		provider,
		modelId,
		projectRoot: options.projectRoot,
		evidenceFor,
		semanticSessionId,
		directSessionId,
	};
}

export function cleanupRealBenchmarkContext(context: RealBenchmarkContext): void {
	for (const benchmarkCase of BENCHMARK_CASES) {
		for (const phase of ["initial", "followup"] as const) {
			cleanupSessionResources(semanticProviderSessionId(context.semanticSessionId(benchmarkCase), phase));
			cleanupSessionResources(semanticProviderSessionId(context.semanticSessionId(benchmarkCase), phase, true));
		}
		cleanupSessionResources(context.directSessionId(benchmarkCase));
	}
}
