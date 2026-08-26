import { pathToFileURL } from "node:url";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { COMPACTION_BENCHMARK_CORPUS } from "./compaction-corpus.ts";
import { nearestRank, scoreCompactionOutput } from "./compaction-score.ts";

interface Distribution {
	readonly count: number;
	readonly meanMs: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly minimumMs: number;
	readonly maximumMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
	return parsed;
}

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) throw new Error("Compaction benchmark produced no duration samples");
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		count: values.length,
		meanMs: total / values.length,
		p50Ms: nearestRank(values, 0.5),
		p95Ms: nearestRank(values, 0.95),
		minimumMs: Math.min(...values),
		maximumMs: Math.max(...values),
	};
}

function run() {
	const warmups = positiveInteger(argumentValue("--warmups"), 5);
	const repetitions = positiveInteger(argumentValue("--repetitions"), 30);
	const check = process.argv.includes("--check");
	const durations: number[] = [];

	for (let index = 0; index < warmups + repetitions; index++) {
		const startedAt = performance.now();
		for (const benchmarkCase of COMPACTION_BENCHMARK_CORPUS) {
			serializeConversation([...benchmarkCase.messages]);
		}
		const durationMs = performance.now() - startedAt;
		if (index >= warmups) durations.push(durationMs);
	}

	const cases = COMPACTION_BENCHMARK_CORPUS.map((benchmarkCase) => {
		const source = JSON.stringify(benchmarkCase.messages);
		const output = serializeConversation([...benchmarkCase.messages]);
		const quality = scoreCompactionOutput(output, benchmarkCase.expectations);
		const estimatedTokensBefore = Math.ceil(source.length / 4);
		const estimatedTokensAfter = Math.ceil(output.length / 4);
		return {
			id: benchmarkCase.id,
			quality,
			sourceChars: source.length,
			serializedChars: output.length,
			estimatedTokensBefore,
			estimatedTokensAfter,
			tokenReduction: 1 - estimatedTokensAfter / estimatedTokensBefore,
		};
	});

	const violations: string[] = [];
	for (const benchmarkCase of cases) {
		if (benchmarkCase.quality.macroRetention < 1) {
			violations.push(`${benchmarkCase.id}: retention ${benchmarkCase.quality.macroRetention.toFixed(3)} < 1`);
		}
		if (benchmarkCase.quality.staleLeakRate > 0) {
			violations.push(`${benchmarkCase.id}: stale leak ${benchmarkCase.quality.staleLeakRate.toFixed(3)} > 0`);
		}
		if (benchmarkCase.tokenReduction < 0.45) {
			violations.push(`${benchmarkCase.id}: token reduction ${benchmarkCase.tokenReduction.toFixed(3)} < 0.45`);
		}
	}
	const speed = distribution(durations);
	if (speed.p95Ms > 50) violations.push(`serialization p95 ${speed.p95Ms.toFixed(3)}ms > 50ms`);

	const report = {
		schemaVersion: 1,
		mode: "local-serializer",
		runtime: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		config: { warmups, repetitions },
		speed: { serialization: speed },
		quality: { cases },
		acceptance: { passed: violations.length === 0, violations },
	};
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (check && violations.length > 0) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) run();
