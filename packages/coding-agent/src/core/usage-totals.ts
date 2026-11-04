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
	if (entry.type === "branch_summary" || entry.type === "compaction") {
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

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		const usage = getEntryUsage(entry);
		if (!usage) continue;
		const key =
			entry.type === "message" && entry.message.role === "assistant"
				? `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`
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
