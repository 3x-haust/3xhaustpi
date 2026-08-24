import { performance } from "node:perf_hooks";
import { parseProjectId } from "@3xhaust/semantic-contract";
import { compileSemanticOutput } from "../../core/src/index.ts";
import type { ThreeXhaustCommand } from "./args.ts";
import { canonicalProject } from "./cli-project.ts";
import { runRealBenchmark } from "./real-benchmark.ts";

type BenchmarkCommand = Extract<ThreeXhaustCommand, { readonly kind: "benchmark" }>;

async function runSyntheticBenchmark(repetitions: number): Promise<void> {
	const projectId = parseProjectId("prj_benchmark");
	const samples: number[] = [];
	for (let index = 0; index < repetitions; index += 1) {
		const started = performance.now();
		await compileSemanticOutput(
			{
				protocolVersion: 2,
				kind: "intent",
				payload: {
					kind: "inspect",
					objective: "Inspect a reported login failure",
					target: { kind: "behavior", description: "login failure" },
					evidenceGoals: ["Locate relevant behavior"],
					constraints: ["Do not mutate"],
					doneWhen: "Relevant evidence is identified",
				},
			},
			{
				projectId,
				turnId: `turn_${index}`,
				projectRevision: "revision_benchmark",
				observationDigests: [],
			},
		);
		samples.push(performance.now() - started);
	}
	const sorted = [...samples].sort((left, right) => left - right);
	const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
	console.log(
		JSON.stringify(
			{
				mode: "synthetic-local",
				realProvider: "unmeasured",
				repetitions,
				semanticValidity: "measured",
				meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
				p50Ms: percentile(0.5),
				p95Ms: percentile(0.95),
				note: "This measures local compiler overhead only. It is not an LLM performance result.",
			},
			null,
			2,
		),
	);
}

export async function runBenchmarkCommand(command: BenchmarkCommand): Promise<void> {
	if (!command.real) return runSyntheticBenchmark(command.repetitions);
	return runRealBenchmark({
		projectRoot: canonicalProject(command.project),
		repetitions: command.repetitions,
		...(command.provider ? { provider: command.provider } : {}),
		...(command.model ? { model: command.model } : {}),
	});
}
