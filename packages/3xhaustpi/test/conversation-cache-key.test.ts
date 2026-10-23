import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiComplete } from "../../pi-adapter/src/index.ts";
import type { ConversationInput } from "../src/runtime-entry.ts";

const mocks = vi.hoisted(() => ({
	checkAuth: vi.fn(),
	cleanupSessionResources: vi.fn(),
	completeSimple: vi.fn<PiComplete>(),
	createProviderRuntime: vi.fn(),
	resolveModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: mocks.cleanupSessionResources,
}));

vi.mock("../src/provider-runtime.ts", () => ({
	DEFAULT_MODEL: "gpt-default",
	DEFAULT_PROVIDER: "provider-default",
	createProviderRuntime: mocks.createProviderRuntime,
	providerCredentialOverride: vi.fn(),
	resolveModel: mocks.resolveModel,
}));

import { runConversation } from "../src/runtime-entry.ts";

const message: AssistantMessage = {
	role: "assistant",
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "fixture-model",
	stopReason: "stop",
	content: [{ type: "text", text: "answer" }],
	timestamp: 1,
	usage: {
		input: 17,
		output: 9,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 26,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

describe("conversation cache affinity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkAuth.mockResolvedValue(true);
		mocks.createProviderRuntime.mockReturnValue({ checkAuth: mocks.checkAuth, completeSimple: mocks.completeSimple });
		mocks.resolveModel.mockReturnValue({ api: "openai-codex-responses" });
		mocks.completeSimple.mockResolvedValue(message);
	});

	it("routes distinct resource sessions through the explicit key", async () => {
		for (const sessionId of ["request-1", "request-2"]) {
			await runConversation({ system: "Chat.", prompt: "Hello", sessionId, promptCacheKey: "stable-chat" });
			expect(mocks.completeSimple).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.anything(),
				// Codex routes cache affinity by the session-id header, so the provider session is the stable key.
				expect.objectContaining({
					sessionId: "stable-chat",
					promptCacheKey: "stable-chat",
					cacheRetention: "long",
				}),
			);
			expect(mocks.cleanupSessionResources).toHaveBeenLastCalledWith(sessionId);
		}
		expect(mocks.cleanupSessionResources).not.toHaveBeenCalledWith("stable-chat");
	});

	it.each([{ sessionId: "legacy-session" }, { sessionId: "legacy-session", promptCacheKey: undefined }])(
		"falls back to sessionId when the key is omitted: %j",
		async (input) => {
			await runConversation({ system: "Chat.", prompt: "Hello", ...input });
			expect(mocks.completeSimple.mock.calls[0]?.[2]).toMatchObject({
				sessionId: "legacy-session",
				promptCacheKey: "legacy-session",
				cacheRetention: "long",
			});
		},
	);

	it.each(["a".repeat(65), "\u{1d11e}".repeat(65)])("clamps long keys by Unicode code point: %s", async (key) => {
		await runConversation({ system: "Chat.", prompt: "Hello", sessionId: "resource", promptCacheKey: key });
		expect(mocks.completeSimple.mock.calls[0]?.[2]).toMatchObject({
			sessionId: Array.from(key).slice(0, 64).join(""),
			promptCacheKey: Array.from(key).slice(0, 64).join(""),
			cacheRetention: "long",
		});
	});

	it("clamps the legacy fallback without changing its resource identity", async () => {
		const sessionId = "s".repeat(80);
		await runConversation({ system: "Chat.", prompt: "Hello", sessionId });
		expect(mocks.completeSimple.mock.calls[0]?.[2]).toMatchObject({
			sessionId: "s".repeat(64),
			promptCacheKey: "s".repeat(64),
			cacheRetention: "long",
		});
		expect(mocks.cleanupSessionResources).toHaveBeenCalledWith(sessionId);
	});

	it.each(["", "k".repeat(64), "\u{1d11e}".repeat(64)])(
		"preserves keys within the limit: %s",
		async (promptCacheKey) => {
			await runConversation({ system: "Chat.", prompt: "Hello", promptCacheKey });
			const options = mocks.completeSimple.mock.calls[0]?.[2];
			expect(options).toMatchObject({ promptCacheKey, cacheRetention: "long" });
			if (promptCacheKey) expect(options).toMatchObject({ sessionId: promptCacheKey });
			else expect(options).not.toHaveProperty("sessionId");
			expect(mocks.cleanupSessionResources).not.toHaveBeenCalled();
		},
	);

	it.each([{}, { sessionId: "" }] satisfies Partial<ConversationInput>[])(
		"preserves keyless requests: %j",
		async (input) => {
			await runConversation({ system: "Chat.", prompt: "Hello", ...input });
			const options = mocks.completeSimple.mock.calls[0]?.[2];
			expect(options).not.toHaveProperty("sessionId");
			expect(options).not.toHaveProperty("promptCacheKey");
			expect(options?.cacheRetention).toBe("long");
		},
	);

	it("cleans up the resource session on failure with an explicit cache key", async () => {
		mocks.completeSimple.mockRejectedValue(new Error("fixture failure"));
		await expect(
			runConversation({ system: "Chat.", prompt: "Hello", sessionId: "resource", promptCacheKey: "stable-chat" }),
		).rejects.toThrow("fixture failure");
		expect(mocks.cleanupSessionResources).toHaveBeenCalledExactlyOnceWith("resource");
	});
});
