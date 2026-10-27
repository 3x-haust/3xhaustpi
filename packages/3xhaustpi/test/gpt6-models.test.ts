import { describe, expect, it } from "vitest";
import { createProviderRuntime, modelContextWindow, resolveModel } from "../src/provider-runtime.ts";

describe("bundled GPT-6 catalog", () => {
	const cases = [
		["gpt-6-astra", 10, 1, 50, null],
		["gpt-6.1-sol", 2, 0.1, 10, null],
		["gpt-6.1-terra", 1, 0.05, 5, "none"],
		["gpt-6-sol", 2, 0.2, 10, "none"],
		["gpt-6-luna", 0.1, 0.01, 0.5, "none"],
	] as const;
	for (const provider of ["openai", "openai-codex"]) {
		it.each(cases)(`${provider}/%s resolves without credentials`, (id, input, cacheRead, output, off) => {
			const runtime = createProviderRuntime();
			const model = resolveModel(runtime, provider, id);
			expect(runtime.getModels(provider).filter((entry) => entry.id === id)).toHaveLength(1);
			expect(model).toMatchObject({
				id,
				provider,
				api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
				reasoning: true,
				contextWindow: 1050000,
				maxTokens: 128000,
				cost: {
					input,
					cacheRead,
					output,
					tiers: [{ inputTokensAbove: 272000, input: input * 2, cacheRead: cacheRead * 2, output: output * 1.5 }],
				},
				thinkingLevelMap: { off, xhigh: "xhigh", max: "max" },
			});
			expect(modelContextWindow(provider, id)).toBe(1050000);
		});
	}
});
