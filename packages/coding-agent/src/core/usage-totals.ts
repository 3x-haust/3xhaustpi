import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Extract billable usage without including it in context token accounting. */
export function getEntryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
		return entry.message.usage;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "usage") {
		return entry.usage;
	}
	if (entry.type !== "custom" || entry.customType !== "pi.summarization_usage") return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null || !("usage" in data)) return undefined;
	const usage = data.usage;
	if (
		typeof usage !== "object" ||
		usage === null ||
		!("input" in usage) ||
		!("output" in usage) ||
		!("cacheRead" in usage) ||
		!("cacheWrite" in usage) ||
		!("totalTokens" in usage) ||
		!("cost" in usage)
	) {
		return undefined;
	}
	const cost = usage.cost;
	if (
		typeof cost !== "object" ||
		cost === null ||
		!("input" in cost) ||
		!("output" in cost) ||
		!("cacheRead" in cost) ||
		!("cacheWrite" in cost) ||
		!("total" in cost)
	) {
		return undefined;
	}
	const values = [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
		cost.input,
		cost.output,
		cost.cacheRead,
		cost.cacheWrite,
		cost.total,
	];
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
	if ("cacheWrite1h" in usage && usage.cacheWrite1h !== undefined) {
		if (typeof usage.cacheWrite1h !== "number" || !Number.isFinite(usage.cacheWrite1h)) return undefined;
	}
	if ("reasoning" in usage && usage.reasoning !== undefined) {
		if (typeof usage.reasoning !== "number" || !Number.isFinite(usage.reasoning)) return undefined;
	}
	return usage as Usage;
}

/** Sum of two usages, keeping the optional token splits when either side reports them. */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
			// A sum is provider-reported only when every part is.
			totalFromProvider: first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
		},
	};
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		const usage = getEntryUsage(entry);
		if (!usage) continue;
		const key =
			entry.type === "message" && entry.message.role === "assistant"
				? `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`
				: entry.type === "usage"
					? `${entry.provider}/${entry.model}`
					: "Tools/summaries";

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
