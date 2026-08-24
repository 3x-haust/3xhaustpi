import type { Usage } from "@earendil-works/pi-ai";
import type { ArmSample } from "./benchmark-types.ts";

export function totalInput(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function aggregateUsage(
	usages: readonly Usage[],
): Pick<ArmSample, "uncachedInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
	return usages.reduce(
		(sum, usage) => ({
			uncachedInputTokens: sum.uncachedInputTokens + usage.input,
			outputTokens: sum.outputTokens + usage.output,
			cacheReadTokens: sum.cacheReadTokens + usage.cacheRead,
			cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWrite,
		}),
		{ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
	);
}

export function usageFields(
	usage: Usage,
): Pick<ArmSample, "uncachedInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
	return {
		uncachedInputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
	};
}
