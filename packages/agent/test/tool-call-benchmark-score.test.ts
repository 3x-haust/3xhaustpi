import { describe, expect, it } from "vitest";
import {
	evaluateToolCallBenchmark,
	summarizeToolCallBenchmark,
	type ToolCallBenchmarkSample,
} from "../benchmark/tool-call-score.ts";

describe("tool-call benchmark scoring", () => {
	it("reports latency throughput and successful contract completion", () => {
		// Given: two deterministic batches with one failed execution and one orphan.
		const samples: readonly ToolCallBenchmarkSample[] = [
			{
				mode: "parallel",
				requested: 4,
				succeeded: 4,
				contractSucceeded: 4,
				orphaned: 0,
				durationMs: 2,
			},
			{
				mode: "parallel",
				requested: 4,
				succeeded: 3,
				contractSucceeded: 3,
				orphaned: 1,
				durationMs: 6,
			},
		];

		// When: the samples are summarized.
		const summary = summarizeToolCallBenchmark(samples);

		// Then: rates, nearest-rank latency, and throughput reflect the observed calls.
		expect(summary).toEqual({
			batches: 2,
			requested: 8,
			succeeded: 7,
			failed: 1,
			orphaned: 1,
			executionSuccessRate: 0.875,
			contractSuccessRate: 0.875,
			throughputCallsPerSecond: 875,
			latencyMs: {
				count: 2,
				mean: 4,
				p50: 2,
				p95: 6,
				p99: 6,
				minimum: 2,
				maximum: 6,
			},
		});
	});

	it("fails acceptance when success speed or orphan constraints regress", () => {
		// Given: a summary below every required tool-call gate.
		const summary = summarizeToolCallBenchmark([
			{
				mode: "sequential",
				requested: 10,
				succeeded: 9,
				contractSucceeded: 8,
				orphaned: 1,
				durationMs: 20,
			},
		]);

		// When: strict benchmark acceptance is evaluated.
		const acceptance = evaluateToolCallBenchmark(summary, {
			minimumExecutionSuccessRate: 1,
			minimumContractSuccessRate: 1,
			minimumThroughputCallsPerSecond: 1_000,
			maximumP95LatencyMs: 10,
		});

		// Then: each independent regression is reported.
		expect(acceptance.passed).toBe(false);
		expect(acceptance.violations).toHaveLength(5);
	});
});
