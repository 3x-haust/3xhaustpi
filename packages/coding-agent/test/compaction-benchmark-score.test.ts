import { describe, expect, it } from "vitest";
import { COMPACTION_BENCHMARK_CORPUS } from "../benchmark/compaction-corpus.ts";
import {
	type CompactionRetentionExpectation,
	nearestRank,
	scoreCompactionOutput,
} from "../benchmark/compaction-score.ts";

describe("compaction benchmark scoring", () => {
	it("macro-averages retention categories and reports stale leakage", () => {
		// Given: balanced machine-consumed expectations with one lost task and one stale leak.
		const expectations: readonly CompactionRetentionExpectation[] = [
			{ id: "fact", category: "fact", required: ["region=eu-west-1"] },
			{ id: "decision", category: "decision", required: ["retain SQLite"] },
			{ id: "task", category: "open_task", required: ["add migration coverage"] },
			{ id: "path", category: "path", required: ["/workspace/src/recovery.ts"] },
			{ id: "command", category: "command", required: ["npm run test"], forbidden: ["npm run stale"] },
			{ id: "error", category: "error_cause", required: ["SQLITE_BUSY"] },
		];

		// When: output retains five categories but misses the task and leaks stale data.
		const result = scoreCompactionOutput(
			"region=eu-west-1 retain SQLite /workspace/src/recovery.ts npm run test npm run stale SQLITE_BUSY",
			expectations,
		);

		// Then: category recall and leakage remain independently measurable.
		expect(result.macroRetention).toBeCloseTo(5 / 6);
		expect(result.staleLeakRate).toBe(1);
		expect(result.categories.open_task).toMatchObject({ expected: 1, retained: 0, weightedRecall: 0 });
	});

	it("uses nearest-rank percentiles without interpolating samples", () => {
		// Given: an ordered duration population.
		const values = [1, 2, 3, 4, 100];

		// When/Then: p50 and p95 resolve to observed samples.
		expect(nearestRank(values, 0.5)).toBe(3);
		expect(nearestRank(values, 0.95)).toBe(100);
	});

	it("covers every retention category with fixed machine sentinels", () => {
		// Given: the versioned local compaction corpus.
		const categories = new Set(
			COMPACTION_BENCHMARK_CORPUS.flatMap((benchmarkCase) =>
				benchmarkCase.expectations.map((expectation) => expectation.category),
			),
		);

		// When/Then: every continuation-critical category has exact sentinels.
		expect([...categories].sort()).toEqual(["command", "decision", "error_cause", "fact", "open_task", "path"]);
	});
});
