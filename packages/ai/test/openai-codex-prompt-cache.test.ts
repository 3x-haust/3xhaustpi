import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-codex-responses.ts";
import { getModel } from "../src/compat.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CapturedPayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
	sessionHeader?: string | null;
}

async function capturePayload(
	cacheRetention: "none" | "short" | "long",
	promptCacheKey?: string,
): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	let sessionHeader: string | null | undefined;
	const apiKey = `header.${btoa(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
	)}.signature`;
	const response = new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
	const request = streamSimple(
		getModel("openai-codex", "gpt-6-sol"),
		normalizeContext({
			systemPrompt: "Reply concisely.",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		}),
		{
			apiKey,
			cacheRetention,
			sessionId: "cache-session",
			...(promptCacheKey ? { promptCacheKey } : {}),
			transport: "sse",
			fetch: vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sessionHeader = new Headers(init?.headers).get("session-id");
				return response;
			}),
			onPayload: (payload) => {
				captured = payload as CapturedPayload;
			},
		},
	);
	for await (const event of request) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!captured) throw new Error("Codex request payload was not captured");
	return { ...captured, sessionHeader };
}

describe("openai-codex prompt cache request fields", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps long retention implicit because the ChatGPT Codex endpoint rejects the API field", async () => {
		const payload = await capturePayload("long");

		expect(payload.prompt_cache_key).toBe("cache-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("keeps short caching implicit", async () => {
		const payload = await capturePayload("short");

		expect(payload.prompt_cache_key).toBe("cache-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("separates prompt-cache routing from the transport session", async () => {
		const payload = await capturePayload("long", "semantic-followup");

		expect(payload.prompt_cache_key).toBe("semantic-followup");
	});

	it("sends a shared prompt-cache key in the session header too, so Codex routes both alike", async () => {
		const payload = await capturePayload("long", "shared-prefix");

		expect(payload.prompt_cache_key).toBe("shared-prefix");
		expect(payload.sessionHeader).toBe("shared-prefix");
	});

	it("keeps the session header on the session id without a shared key", async () => {
		const payload = await capturePayload("long");

		expect(payload.sessionHeader).toBe("cache-session");
	});

	it("omits all prompt cache fields when caching is disabled", async () => {
		const payload = await capturePayload("none");

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
	});
});
