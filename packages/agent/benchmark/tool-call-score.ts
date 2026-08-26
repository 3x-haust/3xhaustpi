export type ToolCallExecutionMode = "parallel" | "sequential";

export interface ToolCallBenchmarkSample {
	readonly mode: ToolCallExecutionMode;
	readonly requested: number;
	readonly succeeded: number;
	readonly contractSucceeded: number;
	readonly orphaned: number;
	readonly durationMs: number;
}

export interface ToolCallLatencyDistribution {
	readonly count: number;
	readonly mean: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly minimum: number;
	readonly maximum: number;
}

export interface ToolCallBenchmarkSummary {
	readonly batches: number;
	readonly requested: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly orphaned: number;
	readonly executionSuccessRate: number;
	readonly contractSuccessRate: number;
	readonly throughputCallsPerSecond: number;
	readonly latencyMs: ToolCallLatencyDistribution;
}

export interface ToolCallBenchmarkThresholds {
	readonly minimumExecutionSuccessRate: number;
	readonly minimumContractSuccessRate: number;
	readonly minimumThroughputCallsPerSecond: number;
	readonly maximumP95LatencyMs: number;
}

export interface ToolCallBenchmarkAcceptance {
	readonly passed: boolean;
	readonly violations: readonly string[];
}

function nearestRank(sortedValues: readonly number[], percentile: number): number {
	const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
	return sortedValues[index] ?? 0;
}

function latencyDistribution(values: readonly number[]): ToolCallLatencyDistribution {
	if (values.length === 0) {
		return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, minimum: 0, maximum: 0 };
	}
	const sorted = [...values].sort((left, right) => left - right);
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		count: values.length,
		mean: total / values.length,
		p50: nearestRank(sorted, 0.5),
		p95: nearestRank(sorted, 0.95),
		p99: nearestRank(sorted, 0.99),
		minimum: sorted[0] ?? 0,
		maximum: sorted.at(-1) ?? 0,
	};
}

export function summarizeToolCallBenchmark(
	samples: readonly ToolCallBenchmarkSample[],
): ToolCallBenchmarkSummary {
	const requested = samples.reduce((sum, sample) => sum + sample.requested, 0);
	const succeeded = samples.reduce((sum, sample) => sum + sample.succeeded, 0);
	const contractSucceeded = samples.reduce((sum, sample) => sum + sample.contractSucceeded, 0);
	const orphaned = samples.reduce((sum, sample) => sum + sample.orphaned, 0);
	const totalDurationMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
	return {
		batches: samples.length,
		requested,
		succeeded,
		failed: Math.max(0, requested - succeeded),
		orphaned,
		executionSuccessRate: requested === 0 ? 0 : succeeded / requested,
		contractSuccessRate: requested === 0 ? 0 : contractSucceeded / requested,
		throughputCallsPerSecond: totalDurationMs === 0 ? 0 : (succeeded * 1_000) / totalDurationMs,
		latencyMs: latencyDistribution(samples.map((sample) => sample.durationMs)),
	};
}

export function evaluateToolCallBenchmark(
	summary: ToolCallBenchmarkSummary,
	thresholds: ToolCallBenchmarkThresholds,
): ToolCallBenchmarkAcceptance {
	const violations: string[] = [];
	if (summary.executionSuccessRate < thresholds.minimumExecutionSuccessRate) {
		violations.push(
			`execution success ${summary.executionSuccessRate.toFixed(4)} < ${thresholds.minimumExecutionSuccessRate.toFixed(4)}`,
		);
	}
	if (summary.contractSuccessRate < thresholds.minimumContractSuccessRate) {
		violations.push(
			`contract success ${summary.contractSuccessRate.toFixed(4)} < ${thresholds.minimumContractSuccessRate.toFixed(4)}`,
		);
	}
	if (summary.orphaned > 0) {
		violations.push(`orphaned tool calls ${summary.orphaned} > 0`);
	}
	if (summary.throughputCallsPerSecond < thresholds.minimumThroughputCallsPerSecond) {
		violations.push(
			`throughput ${summary.throughputCallsPerSecond.toFixed(1)} calls/s < ${thresholds.minimumThroughputCallsPerSecond.toFixed(1)} calls/s`,
		);
	}
	if (summary.latencyMs.p95 > thresholds.maximumP95LatencyMs) {
		violations.push(
			`batch latency p95 ${summary.latencyMs.p95.toFixed(3)}ms > ${thresholds.maximumP95LatencyMs.toFixed(3)}ms`,
		);
	}
	return { passed: violations.length === 0, violations };
}
