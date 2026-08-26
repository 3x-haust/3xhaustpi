export type CompactionRetentionCategory =
	| "fact"
	| "decision"
	| "open_task"
	| "path"
	| "command"
	| "error_cause";

export interface CompactionRetentionExpectation {
	readonly id: string;
	readonly category: CompactionRetentionCategory;
	readonly required: readonly string[];
	readonly forbidden?: readonly string[];
	readonly weight?: number;
}

export interface CompactionCategoryScore {
	readonly expected: number;
	readonly retained: number;
	readonly weightedRecall: number;
}

export interface CompactionQualityScore {
	readonly categories: Readonly<Record<CompactionRetentionCategory, CompactionCategoryScore>>;
	readonly macroRetention: number;
	readonly staleLeakRate: number;
	readonly retainedIds: readonly string[];
	readonly missingIds: readonly string[];
	readonly leakedForbidden: readonly string[];
}

const CATEGORIES: readonly CompactionRetentionCategory[] = [
	"fact",
	"decision",
	"open_task",
	"path",
	"command",
	"error_cause",
];

export function nearestRank(values: readonly number[], percentile: number): number {
	if (values.length === 0) throw new Error("Nearest-rank percentile requires at least one sample");
	if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
		throw new Error("Nearest-rank percentile must be in (0, 1]");
	}
	const sorted = [...values].sort((left, right) => left - right);
	const result = sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
	if (result === undefined) throw new Error("Nearest-rank percentile resolved no sample");
	return result;
}

export function scoreCompactionOutput(
	output: string,
	expectations: readonly CompactionRetentionExpectation[],
): CompactionQualityScore {
	const retainedIds: string[] = [];
	const missingIds: string[] = [];
	const leakedForbidden: string[] = [];
	const weights = new Map(CATEGORIES.map((category) => [category, { expected: 0, retained: 0 }]));
	let forbiddenCount = 0;

	for (const expectation of expectations) {
		const weight = expectation.weight ?? 1;
		const category = weights.get(expectation.category);
		if (!category) throw new Error(`Unknown compaction retention category: ${expectation.category}`);
		category.expected += weight;
		const retained = expectation.required.every((value) => output.includes(value));
		if (retained) {
			category.retained += weight;
			retainedIds.push(expectation.id);
		} else {
			missingIds.push(expectation.id);
		}
		for (const stale of expectation.forbidden ?? []) {
			forbiddenCount++;
			if (output.includes(stale)) leakedForbidden.push(stale);
		}
	}

	const categoryScore = (category: CompactionRetentionCategory): CompactionCategoryScore => {
		const score = weights.get(category);
		if (!score) throw new Error(`Missing compaction score category: ${category}`);
		return {
			expected: score.expected,
			retained: score.retained,
			weightedRecall: score.expected > 0 ? score.retained / score.expected : 1,
		};
	};
	const categories: Record<CompactionRetentionCategory, CompactionCategoryScore> = {
		fact: categoryScore("fact"),
		decision: categoryScore("decision"),
		open_task: categoryScore("open_task"),
		path: categoryScore("path"),
		command: categoryScore("command"),
		error_cause: categoryScore("error_cause"),
	};
	const macroRetention =
		CATEGORIES.reduce((total, category) => total + categories[category].weightedRecall, 0) / CATEGORIES.length;
	return {
		categories,
		macroRetention,
		staleLeakRate: forbiddenCount > 0 ? leakedForbidden.length / forbiddenCount : 0,
		retainedIds,
		missingIds,
		leakedForbidden,
	};
}
