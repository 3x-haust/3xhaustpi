import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConversation } from "../src/coding-runtime-provider.ts";
import * as providerRuntime from "../src/provider-runtime.ts";
import type { ConversationInput } from "../src/runtime-entry.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const access = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "effort-test" } }))}.signature`;
const input: ConversationInput = {
	provider: "openai-codex",
	model: "gpt-6.1-terra",
	credential: JSON.stringify({ type: "oauth", access, refresh: "unused-fixture", expires: Date.now() + 3600000 }),
	system: "fixture-system",
	prompt: "fixture-prompt",
	sessionId: "resource-session",
	promptCacheKey: "stable-effort-key",
};

function wireFixture(
	metadata: Readonly<Record<string, unknown>> = {},
	format: "responses" | "completions" | "google" | "anthropic" = "responses",
) {
	const requests: { readonly payload: unknown; readonly session: string | null }[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		const headers = new Headers(init?.headers);
		const body = init?.body;
		const payload: unknown =
			typeof body === "string"
				? JSON.parse(body)
				: body instanceof Uint8Array && headers.get("content-encoding") === "zstd"
					? JSON.parse(zstdDecompressSync(body).toString("utf8"))
					: undefined;
		if (!payload) throw new Error("Unexpected request encoding");
		requests.push({ payload, session: headers.get("session-id") });
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "m1", role: "assistant", content: [], status: "in_progress" },
			},
			{
				type: "response.content_part.added",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
			{
				type: "response.completed",
				response: {
					id: "effort-response",
					status: "completed",
					output: [],
					usage: { input_tokens: 32, output_tokens: 1, total_tokens: 33 },
					...metadata,
				},
			},
		];
		const reply =
			format === "completions"
				? [{ id: "chat-fixture", choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]
				: format === "google"
					? [{ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]
					: format === "anthropic"
						? [
								{
									type: "message_start",
									message: { id: "m1", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
								},
								{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
								{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
								{ type: "content_block_stop", index: 0 },
								{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
								{ type: "message_stop" },
							]
						: events;
		return new Response(
			reply
				.map(
					(event) =>
						`${format === "anthropic" && "type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
				)
				.join(""),
			{
				headers: { "content-type": "text/event-stream" },
			},
		);
	};
	vi.stubGlobal("fetch", fetch);
	return requests;
}

describe("conversation reasoning effort at the HTTP boundary", () => {
	it.each(["none", "high"] as const)(
		"rejects %s when a completions adapter emits no reasoning control",
		async (reasoningEffort) => {
			// Given: this model is reasoning-capable but its installed adapter exposes no controls.
			const requests = wireFixture({}, "completions");
			// When: either off or an explicit effort would be silently ignored.
			await expect(
				runConversation({
					...input,
					provider: "nvidia",
					model: "meta/muse-glimmer-30b",
					credential: "fixture-key",
					reasoningEffort,
				}),
			).rejects.toThrow(/Unsupported reasoning effort/u);
			// Then: a model reasoning flag alone never causes a misleading successful dispatch.
			expect(requests).toEqual([]);
		},
	);
	it.each([
		["azure-openai-responses", "gpt-5", "high", { reasoning: { effort: "high" } }],
		["google-vertex", "gemini-3.1-pro-preview", "low", { config: { thinkingConfig: { thinkingLevel: "LOW" } } }],
		["google-vertex", "gemini-2.5-flash", "none", { config: { thinkingConfig: { thinkingBudget: 0 } } }],
		[
			"amazon-bedrock",
			"anthropic.claude-opus-4-7",
			"high",
			{ additionalModelRequestFields: { output_config: { effort: "high" } } },
		],
		["amazon-bedrock", "anthropic.claude-opus-4-7", "none", {}],
	] as const)(
		"assembles %s/%s effort %s before native transport",
		async (provider, model, reasoningEffort, expected) => {
			// Given: the real runtime and adapter, intercepted immediately before native SDK transport.
			const credential = JSON.stringify({
				type: "api_key",
				key: "fixture-key",
				env: { AZURE_OPENAI_BASE_URL: "https://example.invalid" },
			});
			const runtime = providerRuntime.createProviderRuntime(
				providerRuntime.providerCredentialOverride(provider, credential),
			);
			const complete = runtime.completeSimple.bind(runtime);
			let captured: unknown;
			const network = vi.fn(() => {
				throw new Error("Unexpected network request");
			});
			vi.stubGlobal("fetch", network);
			vi.spyOn(providerRuntime, "createProviderRuntime").mockReturnValue(runtime);
			vi.spyOn(runtime, "completeSimple").mockImplementation((requestModel, context, options) =>
				complete(requestModel, context, {
					...options,
					onPayload: async (payload, payloadModel) => {
						captured = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
						throw new Error("fixture payload captured");
					},
				}),
			);
			// When: the conversation reaches the native request boundary with its actual options.
			await expect(runConversation({ ...input, provider, model, credential, reasoningEffort })).rejects.toThrow(
				"fixture payload captured",
			);
			// Then: the native body has its API's format and no provider was contacted.
			expect(captured).toMatchObject(expected);
			if (provider === "amazon-bedrock" && reasoningEffort === "none")
				expect(captured).toHaveProperty("additionalModelRequestFields", undefined);
			expect(network).not.toHaveBeenCalled();
		},
	);

	it("rejects Bedrock reasoning when the installed adapter ignores it for a non-Claude model", async () => {
		// Given: Nova is marked reasoning-capable, but this installed adapter only encodes Claude controls.
		const requests = wireFixture();
		// When: the explicit effort would otherwise disappear from the request.
		await expect(
			runConversation({
				...input,
				provider: "amazon-bedrock",
				model: "amazon.nova-2-lite-v1:0",
				credential: "fixture-key",
				reasoningEffort: "high",
			}),
		).rejects.toThrow(/Unsupported reasoning effort/u);
		// Then: no network transport is attempted.
		expect(requests).toEqual([]);
	});
	it.each([
		["baseten", "deepseek-ai/DeepSeek-V4-Pro", "none", { reasoning_effort: "none" }, "completions"],
		["baseten", "deepseek-ai/DeepSeek-V4-Pro", "max", { reasoning_effort: "max" }, "completions"],
		[
			"baseten",
			"zai-org/GLM-5.2",
			"none",
			{ reasoning_effort: "none", chat_template_args: { enable_thinking: false } },
			"completions",
		],
		["baseten", "moonshotai/Kimi-K2.5", "none", { chat_template_args: { enable_thinking: false } }, "completions"],
		["openrouter", "openai/gpt-oss-120b", "none", { reasoning: { effort: "none" } }, "completions"],
		["openrouter", "openai/gpt-oss-120b", "high", { reasoning: { effort: "high" } }, "completions"],
		["ant-ling", "Ring-2.6-1T", "xhigh", { reasoning: { effort: "xhigh" } }, "completions"],
		["deepseek", "deepseek-v4-pro", "none", { thinking: { type: "disabled" } }, "completions"],
		["deepseek", "deepseek-v4-pro", "max", { thinking: { type: "enabled" }, reasoning_effort: "max" }, "completions"],
		["opencode-go", "qwen3.6-plus", "high", { enable_thinking: true }, "completions"],
		["together", "MiniMaxAI/MiniMax-M3", "high", { reasoning: { enabled: true } }, "completions"],
		["zai", "glm-5.2", "none", { thinking: { type: "disabled" } }, "completions"],
		["zai", "glm-5.2", "max", { thinking: { type: "enabled" }, reasoning_effort: "max" }, "completions"],
		[
			"google",
			"gemini-3.1-pro-preview",
			"low",
			{ generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } } },
			"google",
		],
		[
			"google",
			"gemini-3.1-pro-preview",
			"high",
			{ generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } },
			"google",
		],
		["google", "gemini-2.5-flash", "none", { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, "google"],
		["anthropic", "claude-opus-4-7", "none", { thinking: { type: "disabled" } }, "anthropic"],
		[
			"anthropic",
			"claude-opus-4-7",
			"high",
			{ thinking: { type: "adaptive" }, output_config: { effort: "high" } },
			"anthropic",
		],
		["mistral", "magistral-medium-latest", "none", {}, "completions"],
		["mistral", "magistral-medium-latest", "high", { prompt_mode: "reasoning" }, "completions"],
		["mistral", "mistral-small-2603", "high", { reasoning_effort: "high" }, "completions"],
	] as const)(
		"encodes %s/%s effort %s using its installed adapter",
		async (provider, model, reasoningEffort, expected, format) => {
			// Given: provider-native streaming responses and real installed model/adapter metadata.
			const requests = wireFixture({}, format);
			// When: the conversation selects an explicit model-supported effort.
			const result = await runConversation({
				...input,
				provider,
				model,
				credential: "fixture-key",
				reasoningEffort,
			});
			// Then: the API's own shape is preserved, including its off representation.
			expect(result.text).toBe("OK");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.payload).toMatchObject(expected);
			if (provider !== "openrouter" && provider !== "ant-ling")
				expect(requests[0]?.payload).not.toHaveProperty("reasoning.effort");
			if (provider === "mistral" && reasoningEffort === "none") {
				expect(requests[0]?.payload).not.toHaveProperty("prompt_mode");
				expect(requests[0]?.payload).not.toHaveProperty("reasoning_effort");
			}
		},
	);

	it("rejects a Mistral effort that the adapter would silently replace with high", async () => {
		// Given: this adapter exposes high effort but has no low effort mapping.
		const requests = wireFixture({}, "completions");
		// When: low is selected rather than allowing silent translation to high.
		await expect(
			runConversation({
				...input,
				provider: "mistral",
				model: "mistral-small-2603",
				credential: "fixture-key",
				reasoningEffort: "low",
			}),
		).rejects.toThrow(/Unsupported reasoning effort/u);
		// Then: validation fails before network dispatch.
		expect(requests).toEqual([]);
	});
	it.each(["none", "low", "medium", "high", "xhigh", "max"] as const)(
		"sends exact Terra effort %s through the installed adapter",
		async (reasoningEffort) => {
			// Given: a fake transport, with the real catalog and installed pi-ai adapter.
			const requests = wireFixture();
			// When: a conversation explicitly selects a supported provider effort.
			const result = await runConversation({ ...input, reasoningEffort });
			// Then: the wire carries the exact effort and unchanged cache affinity.
			expect(requests).toEqual([
				{
					payload: expect.objectContaining({
						model: "gpt-6.1-terra",
						reasoning: expect.objectContaining({ effort: reasoningEffort }),
						prompt_cache_key: "stable-effort-key",
					}),
					session: "stable-effort-key",
				},
			]);
			expect(result.text).toBe("OK");
			expect(result).not.toHaveProperty("reasoningEffort");
			expect(result).not.toHaveProperty("responseModel");
		},
	);

	it.each(["none", "low", "max"] as const)(
		"sends OpenAI Terra effort %s without Codex auth",
		async (reasoningEffort) => {
			// Given: the OpenAI API-key transport uses the same reviewed Terra catalog.
			const requests = wireFixture({ reasoning: { effort: reasoningEffort }, model: "gpt-6.1-terra" });
			// When: a conversation selects an exact effort through completeSimple.
			const result = await runConversation({
				...input,
				provider: "openai",
				credential: "fixture-key",
				reasoningEffort,
			});
			// Then: both request effort and response evidence survive the API adapter.
			expect(requests).toHaveLength(1);
			expect(requests[0]?.payload).toMatchObject({ reasoning: { effort: reasoningEffort } });
			expect(result).toMatchObject({ responseModel: "gpt-6.1-terra", reasoningEffort });
		},
	);

	it("preserves omitted effort without adding reasoning to the request", async () => {
		// Given: no explicit effort and no reported model or effort.
		const requests = wireFixture();
		// When: the legacy conversation input is used.
		await runConversation(input);
		// Then: provider defaults remain in control.
		expect(requests).toHaveLength(1);
		expect(requests[0]?.payload).not.toHaveProperty("reasoning");
	});

	it("returns provider-reported effort and model rather than echoing the selection", async () => {
		// Given: a terminal response reporting a different effort and concrete model.
		wireFixture({ reasoning: { effort: "medium" }, model: "gpt-6.1-terra-resolved" });
		// When: the request selected low effort.
		const result = await runConversation({ ...input, reasoningEffort: "low" });
		// Then: only response evidence supplies the observation.
		expect(result).toMatchObject({
			reasoningEffort: "medium",
			responseModel: "gpt-6.1-terra-resolved",
			model: "gpt-6.1-terra-resolved",
		});
	});

	it("keeps cache routing across repeated and changed efforts", async () => {
		// Given: one logical conversation with distinct per-call resource sessions.
		const requests = wireFixture();
		// When: effort stays low for two turns and changes on the third.
		for (const [index, reasoningEffort] of (["low", "low", "high"] as const).entries()) {
			await runConversation({ ...input, sessionId: `resource-${index}`, reasoningEffort });
		}
		// Then: effort never enters the session header or cache key.
		expect(requests).toHaveLength(3);
		for (const request of requests) {
			expect(request.session).toBe("stable-effort-key");
			expect(request.payload).toHaveProperty("prompt_cache_key", "stable-effort-key");
		}
	});

	it.each([
		["gpt-6.1-terra", "minimal"],
		["gpt-6.1-sol", "none"],
		["gpt-6.1-terra", "off"],
		["gpt-6.1-terra", "ultra"],
		["gpt-6.1-terra", ""],
		["gpt-6.1-terra", null],
	])("rejects unsupported %s effort %s before transport", async (model, reasoningEffort) => {
		// Given: an unsupported provider value, including untyped JavaScript input.
		const requests = wireFixture();
		// When: the public runtime boundary receives that input.
		await expect(Reflect.apply(runConversation, undefined, [{ ...input, model, reasoningEffort }])).rejects.toThrow(
			/Unsupported reasoning effort/u,
		);
		// Then: no request is silently clamped or sent.
		expect(requests).toEqual([]);
	});
});
