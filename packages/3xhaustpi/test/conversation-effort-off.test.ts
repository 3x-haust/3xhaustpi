import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { conversationReasoningOptions } from "../src/conversation-reasoning.ts";
import { createProviderRuntime } from "../src/provider-runtime.ts";

const runtime = createProviderRuntime();

function catalogModel(provider: string, id: string): Model<Api> {
	const model = runtime.getModels(provider).find((entry) => entry.id === id);
	if (!model) throw new Error(`fixture model missing: ${provider}/${id}`);
	return model;
}

function sendNone(model: Model<Api>, payload: object): unknown {
	return conversationReasoningOptions(model, "none").onPayload?.(payload);
}

describe("explicit reasoning off", () => {
	it.each([
		["google", "gemini-2.5-pro"],
		["google-vertex", "gemini-2.5-pro"],
	])("rejects %s/%s before dispatch because thinking cannot be disabled", (provider, id) => {
		// Given: Google documents 2.5 Pro as unable to disable thinking, while the adapter would send budget 0.
		const model = catalogModel(provider, id);
		// When / Then: off is refused instead of being silently ignored by the provider.
		expect(() => conversationReasoningOptions(model, "none")).toThrow(/Unsupported reasoning effort/u);
	});

	it("rejects a Gemini 3 off request that the adapter encodes as the lowest thinking level", () => {
		// Given: a Gemini model without a declared off level and the adapter's substitute payload.
		const model = { ...catalogModel("google", "gemini-2.5-flash"), id: "gemini-3.1-pro-preview" };
		// When / Then: a payload that still thinks is not accepted as off.
		expect(() => sendNone(model, { config: { thinkingConfig: { thinkingLevel: "LOW" } } })).toThrow(
			/Unsupported reasoning effort/u,
		);
		expect(sendNone(model, { config: { thinkingConfig: { thinkingBudget: 0 } } })).toBeDefined();
	});

	it.each(["gpt-6.1-sol", "gpt-6-astra"])("rejects off for openai-codex/%s whose catalog forbids it", (id) => {
		expect(() => conversationReasoningOptions(catalogModel("openai-codex", id), "none")).toThrow(
			/Unsupported reasoning effort/u,
		);
	});

	it("rejects off for a Responses model with no declared off level", () => {
		// Given: missing off metadata means the adapter would omit reasoning and the model default would apply.
		const model = runtime
			.getModels("openai-codex")
			.find((entry) => entry.reasoning && entry.thinkingLevelMap?.off === undefined);
		expect(model).toBeDefined();
		expect(() => conversationReasoningOptions(model as Model<Api>, "none")).toThrow(/Unsupported reasoning effort/u);
	});

	it.each(["gpt-6.1-terra", "gpt-6-luna"])("sends the declared off value for openai-codex/%s", (id) => {
		expect(sendNone(catalogModel("openai-codex", id), { model: id })).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it("accepts Anthropic off only when the body explicitly disables thinking", () => {
		const model = runtime
			.getModels("anthropic")
			.find((entry) => entry.reasoning && entry.thinkingLevelMap?.off !== null);
		expect(model).toBeDefined();
		const claude = model as Model<Api>;
		expect(sendNone(claude, { thinking: { type: "disabled" } })).toBeDefined();
		expect(() => sendNone(claude, { thinking: { type: "adaptive" } })).toThrow(/Unsupported reasoning effort/u);
	});

	it.each(["magistral-medium-latest", "mistral-small-2603"])(
		"rejects off for mistral/%s because omitting reasoning controls does not prove thinking is disabled",
		(id) => {
			expect(() => conversationReasoningOptions(catalogModel("mistral", id), "none")).toThrow(
				/Unsupported reasoning effort/u,
			);
		},
	);
});

describe("Metamong openai-codex routes", () => {
	it.each(
		["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].flatMap((id) =>
			(["low", "medium", "high"] as const).map((effort) => [id, effort] as const),
		),
	)("keeps %s %s on the wire", (id, effort) => {
		// Given: the exact catalog entry and the body the Codex adapter emits for that level.
		const model = catalogModel("openai-codex", id);
		const options = conversationReasoningOptions(model, effort);
		// Then: the selected pi level maps to the requested wire effort and passes unchanged.
		expect(options.reasoning).toBeDefined();
		expect(model.thinkingLevelMap?.[options.reasoning ?? "off"] ?? options.reasoning).toBe(effort);
		expect(options.onPayload?.({ reasoning: { effort } })).toMatchObject({ reasoning: { effort } });
	});
});
