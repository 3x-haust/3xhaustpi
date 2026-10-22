import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ConversationResult as ShippedResult } from "../src/runtime-api.d.ts";
import type { ConversationResult as EntryResult } from "../src/runtime-entry.ts";

const mocks = vi.hoisted(() => ({
	checkAuth: vi.fn(),
	cleanupSessionResources: vi.fn(),
	completeSimple: vi.fn(),
	createProviderRuntime: vi.fn(),
	providerCredentialOverride: vi.fn(),
	resolveModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: mocks.cleanupSessionResources,
}));

vi.mock("../src/provider-runtime.ts", () => ({
	DEFAULT_MODEL: "gpt-default",
	DEFAULT_PROVIDER: "provider-default",
	createProviderRuntime: mocks.createProviderRuntime,
	providerCredentialOverride: mocks.providerCredentialOverride,
	resolveModel: mocks.resolveModel,
}));

import { runConversation } from "../src/runtime-entry.ts";

const usage = {
	input: 17,
	output: 9,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 26,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const message: AssistantMessage = {
	role: "assistant",
	api: "openai-responses",
	provider: "response-provider",
	model: "response-model",
	responseId: "response-fixture",
	stopReason: "length",
	content: [{ type: "text", text: "answer" }],
	timestamp: 1,
	usage: {
		...usage,
		cacheRead: 11,
		cacheWrite: 13,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	},
};

describe("runConversation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkAuth.mockResolvedValue(true);
		mocks.createProviderRuntime.mockReturnValue({ checkAuth: mocks.checkAuth, completeSimple: mocks.completeSimple });
		mocks.providerCredentialOverride.mockImplementation((providerId, credential) => ({ providerId, credential }));
		mocks.resolveModel.mockReturnValue({
			provider: "openai-codex",
			id: "gpt-5.6-terra",
			api: "openai-codex-responses",
		});
	});

	it("preserves response metadata, positive cache counts, and calculated costs", async () => {
		mocks.completeSimple.mockResolvedValue(message);
		const result = await runConversation({ system: "Chat only.", prompt: "Hello" });
		expect(result).toEqual({
			text: "answer",
			inputTokens: 17,
			outputTokens: 9,
			usage: { input: 17, output: 9, cacheRead: 11, cacheWrite: 13 },
			cost: message.usage.cost,
			stopReason: "length",
			responseId: "response-fixture",
			provider: "response-provider",
			model: "response-model",
		});
		expectTypeOf(result).toEqualTypeOf<ShippedResult>();
		expectTypeOf(result).toEqualTypeOf<EntryResult>();
		const legacy: EntryResult = { text: "answer", inputTokens: 17, outputTokens: 9 };
		expect(legacy.text).toBe("answer");
	});

	it("prefers the provider-reported response model over the requested model", async () => {
		mocks.completeSimple.mockResolvedValue({ ...message, responseModel: "resolved-model" });
		expect((await runConversation({ system: "Chat only.", prompt: "Hello" })).model).toBe("resolved-model");
	});

	it("returns null for missing metadata, cache counts, and cost", async () => {
		mocks.completeSimple.mockResolvedValue({
			content: message.content,
			usage: { input: 17, output: 9 },
		});
		expect(await runConversation({ system: "Chat only.", prompt: "Hello" })).toEqual({
			text: "answer",
			inputTokens: 17,
			outputTokens: 9,
			usage: { input: 17, output: 9, cacheRead: null, cacheWrite: null },
			cost: null,
			stopReason: null,
			responseId: null,
			provider: null,
			model: null,
		});
	});

	it("preserves zero tokens and costs but reports zero cache counts as unknown", async () => {
		mocks.completeSimple.mockResolvedValue({ ...message, usage: { ...usage, input: 0, output: 0 } });
		const result = await runConversation({ system: "Chat only.", prompt: "Hello" });
		expect(result).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
			usage: { input: 0, output: 0, cacheRead: null, cacheWrite: null },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("normalizes missing individual cost fields without changing known costs", async () => {
		mocks.completeSimple.mockResolvedValue({ ...message, usage: { ...usage, cost: { input: 0, total: 1 } } });
		expect((await runConversation({ system: "Chat only.", prompt: "Hello" })).cost).toEqual({
			input: 0,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			total: 1,
		});
	});

	it.each(["error", "aborted"] as const)("rejects %s messages and releases session resources", async (stopReason) => {
		mocks.completeSimple.mockResolvedValue({ ...message, stopReason, errorMessage: "provider failure" });
		await expect(
			runConversation({ system: "Chat only.", prompt: "Hello", sessionId: "failed-session" }),
		).rejects.toThrow("provider failure");
		expect(mocks.cleanupSessionResources).toHaveBeenCalledWith("failed-session");
	});

	it("rejects empty text and still releases session resources", async () => {
		mocks.completeSimple.mockResolvedValue({ ...message, content: [{ type: "text", text: "  " }] });
		await expect(
			runConversation({ system: "Chat only.", prompt: "Hello", sessionId: "empty-session" }),
		).rejects.toThrow("Conversation provider returned no text");
		expect(mocks.cleanupSessionResources).toHaveBeenCalledWith("empty-session");
	});
});
