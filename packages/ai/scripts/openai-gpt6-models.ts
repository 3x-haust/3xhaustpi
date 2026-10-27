import type { Api, Model } from "../src/types.ts";

// Official model pages and pricing, checked 2026-10-22:
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/codex/pricing
// Terra checked 2026-10-27 (including none and the >272K pricing tier):
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/docs/pricing
const GPT6_MODELS = [
	{ id: "gpt-6-astra", name: "GPT-6 Astra", input: 10, cacheRead: 1, output: 50, supportsNone: false },
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: 2, cacheRead: 0.1, output: 10, supportsNone: false },
	{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra", input: 1, cacheRead: 0.05, output: 5, supportsNone: true },
	{ id: "gpt-6-sol", name: "GPT-6 Sol", input: 2, cacheRead: 0.2, output: 10, supportsNone: true },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", input: 0.1, cacheRead: 0.01, output: 0.5, supportsNone: true },
] as const;

/** Keep external OpenAI metadata; supply missing models and the explicit Codex catalog. */
export function addOpenAiGpt6Models(models: Model<Api>[]): void {
	for (const spec of GPT6_MODELS) {
		for (const provider of ["openai", "openai-codex"] as const) {
			const existing = models.find((model) => model.provider === provider && model.id === spec.id);
			const model: Model<Api> = existing ?? {
				id: spec.id,
				name: spec.name,
				api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
				provider,
				baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: spec.input,
					output: spec.output,
					cacheRead: spec.cacheRead,
					cacheWrite: spec.input * 1.25,
				},
				contextWindow: 1050000,
				maxTokens: 128000,
				thinkingLevelMap: {
					off: spec.supportsNone ? "none" : null,
					minimal: provider === "openai-codex" ? "low" : null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				},
			};
			// Long-context pricing applies to the entire request above 272K input tokens.
			model.cost = {
				...model.cost,
				tiers: model.cost.tiers ?? [
					{
						inputTokensAbove: 272000,
						input: model.cost.input * 2,
						output: model.cost.output * 1.5,
						cacheRead: model.cost.cacheRead * 2,
						cacheWrite: model.cost.cacheWrite * 2,
					},
				],
			};
			if (!existing) models.push(model);
		}
	}
}
