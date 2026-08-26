import { describe, expect, it } from "vitest";
import { runToolCallBenchmark } from "../benchmark/tool-call-benchmark.ts";

describe("tool-call execution benchmark", () => {
	it("executes every requested call through both agent-loop modes", async () => {
		// Given: a small deterministic benchmark suitable for the test suite.
		const config = {
			batchSize: 8,
			warmups: 1,
			repetitions: 2,
			thresholds: {
				minimumExecutionSuccessRate: 1,
				minimumContractSuccessRate: 1,
				minimumThroughputCallsPerSecond: 1,
				maximumP95LatencyMs: 1_000,
			},
		} as const;

		// When: the real agent-loop tool dispatcher runs the benchmark.
		const report = await runToolCallBenchmark(config);

		// Then: both execution modes complete every tool-call contract without orphans.
		expect(report.acceptance).toEqual({ passed: true, violations: [] });
		expect(report.results.map((result) => result.mode)).toEqual(["parallel", "sequential"]);
		for (const result of report.results) {
			expect(result.summary.requested).toBe(16);
			expect(result.summary.executionSuccessRate).toBe(1);
			expect(result.summary.contractSuccessRate).toBe(1);
			expect(result.summary.orphaned).toBe(0);
		}
	});
});
