import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { warmAgentPromptCache } from "../src/agent-cache-warm.ts";

describe("warmAgentPromptCache", () => {
	it("replays an immutable cached prefix without mutating session history", async () => {
		// Given: an idle session with one reusable conversation prefix.
		const messages = [{ role: "user", content: "Keep this prefix", timestamp: 1 }];
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 9_999,
			cacheWrite: 0,
			totalTokens: 10_001,
			cost: { input: 0.00001, output: 0.00002, cacheRead: 0.001, cacheWrite: 0, total: 0.00103 },
		};
		let providerContext: unknown;
		let providerOptions: unknown;
		const streamFunction = vi.fn((_model: unknown, context: unknown, options: unknown) => {
			providerContext = context;
			providerOptions = options;
			return {
				result: async () => ({
					role: "assistant",
					content: [{ type: "text", text: "." }],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					usage,
					stopReason: "stop",
					timestamp: 2,
				}),
			};
		});
		const session = {
			isIdle: true,
			model: {
				id: "gpt-5.6-terra",
				name: "gpt-5.6-terra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://example.invalid",
				reasoning: true,
				input: ["text"],
				cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			},
			systemPrompt: "System",
			messages,
			agent: {
				state: { tools: [] },
				convertToLlm: vi.fn(async (value) => value),
				transformContext: undefined,
				streamFunction,
			},
			modelRuntime: {
				getAuth: vi.fn(async () => ({ auth: { apiKey: "token", headers: {} }, env: {} })),
			},
		} as unknown as AgentSession;

		// When: the cache prefix is refreshed.
		const result = await warmAgentPromptCache(session, new AbortController().signal);

		// Then: only the provider request gains a bounded suffix and history stays unchanged.
		expect(messages).toEqual([{ role: "user", content: "Keep this prefix", timestamp: 1 }]);
		expect(streamFunction).toHaveBeenCalledOnce();
		expect(providerContext).toMatchObject({
			systemPrompt: "System",
			messages: [
				{ role: "user", content: "Keep this prefix", timestamp: 1 },
				{ role: "user", content: [{ type: "text", text: "." }] },
			],
		});
		expect(providerOptions).toMatchObject({ maxTokens: 16, apiKey: "token" });
		expect(result).toMatchObject({
			contextTokens: 10_000,
			usage: { input: 1, output: 1, cacheRead: 9_999, cacheWrite: 0 },
		});
		expect(result.estimatedSavingsUsd).toBeGreaterThan(0);
	});
});
