import { expect, it } from "vitest";
import { addOpenAiGpt6Models } from "../scripts/openai-gpt6-models.ts";
import type { Api, Model } from "../src/types.ts";

it("supplies both GPT-6 catalogs when external metadata is missing", () => {
	const models: Model<Api>[] = [];
	addOpenAiGpt6Models(models);
	expect(models).toHaveLength(10);
	for (const model of models) {
		expect(model.contextWindow).toBe(1050000);
		expect(model.cost.tiers?.[0]?.inputTokensAbove).toBe(272000);
		expect(model.thinkingLevelMap?.max).toBe("max");
	}
	addOpenAiGpt6Models(models);
	expect(models).toHaveLength(10);
});

it("keeps external model metadata while adding missing long-context pricing", () => {
	const model: Model<"openai-responses"> = {
		id: "gpt-6.1-sol",
		name: "External model name",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		contextWindow: 1050000,
		maxTokens: 128000,
		thinkingLevelMap: { off: null, minimal: null, max: "max" },
	};
	const models: Model<Api>[] = [model];
	addOpenAiGpt6Models(models);
	expect(models[0]).toBe(model);
	expect(model.name).toBe("External model name");
	expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, max: "max" });
	expect(model.cost.tiers).toEqual([
		{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
	]);
});
