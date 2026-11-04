import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Api, Context, Model, Usage } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const token = `test.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).toString("base64")}.test`;
const responseUsage = {
	input_tokens: 100,
	input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
	output_tokens: 20,
	output_tokens_details: { reasoning_tokens: 7 },
	total_tokens: 120,
};
const expectedUsage = { input: 50, output: 20, cacheRead: 30, cacheWrite: 20, totalTokens: 120 };

function createModel<TApi extends Api>(api: TApi, provider: string): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider,
		baseUrl: "https://provider.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 3 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

function sseResponse(events: Record<string, unknown>[], anthropic = false): Response {
	return new Response(
		events.map((event) => `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function expectUsage(usage: Usage, multiplier = 1): void {
	expect(usage).toMatchObject(expectedUsage);
	expect(usage.cost.input).toBeCloseTo(0.0001 * multiplier, 10);
	expect(usage.cost.output).toBeCloseTo(0.00008 * multiplier, 10);
	expect(usage.cost.cacheRead).toBeCloseTo(0.000015 * multiplier, 10);
	expect(usage.cost.cacheWrite).toBeCloseTo(0.00006 * multiplier, 10);
	expect(usage.cost.total).toBeCloseTo(0.000255 * multiplier, 10);
}

afterEach(() => vi.unstubAllGlobals());

describe("provider cache usage normalization", () => {
	it.each(["omitted", "null", "repeated"] as const)(
		"preserves Anthropic cache counts with %s final input usage",
		async (finalUsage) => {
			const inputUsage = { input_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 };
			const finalInputUsage =
				finalUsage === "repeated"
					? inputUsage
					: finalUsage === "null"
						? { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null }
						: {};
			const fetch = vi.fn(async () =>
				sseResponse(
					[
						{ type: "message_start", message: { id: "msg_test", usage: { ...inputUsage, output_tokens: 1 } } },
						{ type: "message_delta", delta: {}, usage: { ...inputUsage, output_tokens: 10 } },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { ...finalInputUsage, output_tokens: 20 },
						},
						{ type: "message_stop" },
					],
					true,
				),
			);
			const result = await streamAnthropic(createModel("anthropic-messages", "anthropic"), context, {
				apiKey: "test-key",
				fetch,
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expectUsage(result.usage);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("accepts explicit zero Anthropic cache counts instead of retaining earlier counts", async () => {
		const result = await streamAnthropic(createModel("anthropic-messages", "anthropic"), context, {
			apiKey: "test-key",
			fetch: async () =>
				sseResponse(
					[
						{
							type: "message_start",
							message: {
								id: "msg_test",
								usage: {
									input_tokens: 50,
									output_tokens: 1,
									cache_read_input_tokens: 30,
									cache_creation_input_tokens: 20,
								},
							},
						},
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
						},
						{ type: "message_stop" },
					],
					true,
				),
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.usage).toMatchObject({ input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70 });
	});

	for (const provider of ["openai", "openai-codex"] as const) {
		describe(provider, () => {
			it.each([undefined, { status: "failed", error: { code: "server_error", message: "test failure" } }])(
				"keeps provider errors when a failed response has no usage (%j)",
				async (response) => {
					const options = {
						apiKey: token,
						fetch: async () => sseResponse([{ type: "response.failed", response }]),
					};
					const result = await (provider === "openai"
						? streamResponses(createModel("openai-responses", provider), context, options)
						: streamCodex(createModel("openai-codex-responses", provider), context, {
								...options,
								transport: "sse",
							})
					).result();
					expect(result.stopReason).toBe("error");
					expect(result.errorMessage).toContain(
						response ? "test failure" : provider === "openai" ? "Unknown error" : "Codex response failed",
					);
					expect(result.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
				},
			);

			it.each(["completed", "incomplete", "failed"] as const)(
				"preserves cache usage and tier pricing on response.%s",
				async (status) => {
					const event = {
						type: `response.${status}`,
						response: {
							id: "resp_test",
							status,
							service_tier: "priority",
							usage: responseUsage,
							error: status === "failed" ? { code: "server_error", message: "test failure" } : null,
						},
					};
					const fetch = vi.fn(async () => sseResponse([event]));
					const options = { apiKey: token, serviceTier: "priority" as const, fetch, maxRetries: 0 };
					const stream =
						provider === "openai"
							? streamResponses(createModel("openai-responses", provider), context, options)
							: streamCodex(createModel("openai-codex-responses", provider), context, {
									...options,
									transport: "sse",
								});
					const eventTypes: string[] = [];
					for await (const streamEvent of stream) eventTypes.push(streamEvent.type);
					const result = await stream.result();
					expect(result.stopReason).toBe(
						status === "failed" ? "error" : status === "incomplete" ? "length" : "stop",
					);
					if (status === "failed") expect(result.errorMessage).toContain("test failure");
					expect(eventTypes.filter((type) => type === "done" || type === "error")).toEqual([
						status === "failed" ? "error" : "done",
					]);
					expectUsage(result.usage, 2);
					expect(result.usage.reasoning).toBe(7);
					expect(fetch).toHaveBeenCalledTimes(1);
				},
			);
		});
	}

	it.each(["completed", "incomplete", "failed"] as const)(
		"preserves Codex WebSocket response.%s cache usage without an SSE fallback",
		async (status) => {
			class FakeWebSocket extends EventTarget {
				constructor() {
					super();
					queueMicrotask(() => this.dispatchEvent(new Event("open")));
				}

				send(): void {
					queueMicrotask(() =>
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									type: `response.${status}`,
									response: {
										id: "resp_test",
										status,
										usage: responseUsage,
										error: status === "failed" ? { code: "server_error", message: "test failure" } : null,
									},
								}),
							}),
						),
					);
				}

				close(): void {}
			}
			vi.stubGlobal("WebSocket", FakeWebSocket);
			const fetch = vi.fn(async () => {
				throw new Error("Unexpected SSE fallback");
			});
			const result = await streamCodex(createModel("openai-codex-responses", "openai-codex"), context, {
				apiKey: token,
				transport: "auto",
				env: {},
				fetch,
			}).result();
			expect(result.stopReason).toBe(status === "failed" ? "error" : status === "incomplete" ? "length" : "stop");
			if (status === "failed") expect(result.errorMessage).toBe("test failure");
			expectUsage(result.usage);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("preserves Codex cache usage from response.done without counting a repeated terminal event twice", async () => {
		const response = { id: "resp_test", status: "completed", usage: responseUsage };
		const result = await streamCodex(createModel("openai-codex-responses", "openai-codex"), context, {
			apiKey: token,
			transport: "sse",
			fetch: async () =>
				sseResponse([
					{ type: "response.done", response },
					{ type: "response.completed", response },
				]),
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expectUsage(result.usage);
	});

	it("reads the usage-only Completions chunk after finish_reason without double-counting repeated usage", async () => {
		const usage = {
			prompt_tokens: 100,
			prompt_tokens_details: responseUsage.input_tokens_details,
			completion_tokens: 20,
			completion_tokens_details: { reasoning_tokens: 7 },
			total_tokens: 120,
		};
		const result = await streamCompletions(createModel("openai-completions", "openai"), context, {
			apiKey: "test-key",
			fetch: async () =>
				sseResponse([
					{ id: "chat_test", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
					{ id: "chat_test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
					{ id: "chat_test", choices: [], usage },
				]),
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expectUsage(result.usage);
		expect(result.usage.reasoning).toBe(7);
	});
});
