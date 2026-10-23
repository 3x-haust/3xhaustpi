import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConversation } from "../src/coding-runtime-provider.ts";

afterEach(() => vi.unstubAllGlobals());

describe("conversation provider wire", () => {
	it.each([0, 2048, undefined])("reports raw cache count %s through the installed pi-ai adapter", async (cached) => {
		// Given: an isolated HTTP boundary, with no real credential or provider access.
		let payload: unknown;
		let sessionHeader: string | null = null;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const body = init?.body;
			const headers = new Headers(init?.headers);
			sessionHeader = headers.get("session-id");
			if (typeof body === "string") payload = JSON.parse(body);
			else if (body instanceof Uint8Array && headers.get("content-encoding") === "zstd")
				payload = JSON.parse(zstdDecompressSync(body).toString("utf8"));
			else throw new Error("Unexpected request encoding");
			const response = {
				id: "wire-response",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 4096,
					output_tokens: 1,
					total_tokens: 4097,
					input_tokens_details: cached === undefined ? {} : { cached_tokens: cached },
				},
			};
			return new Response(
				[
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
					{ type: "response.completed", response },
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		vi.stubGlobal("fetch", fetch);
		const access = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "wire-test" } }))}.signature`;
		// When: real request assembly and response parsing run against the HTTP fixture.
		const result = await runConversation({
			provider: "openai-codex",
			model: "gpt-6.1-sol",
			credential: JSON.stringify({
				type: "oauth",
				access,
				refresh: "unused-fixture",
				expires: Date.now() + 3600000,
			}),
			system: "fixture-system",
			prompt: "fixture-prompt",
			sessionId: `wire-session-${cached ?? "missing"}`,
			promptCacheKey: "stable-wire-key",
		});
		// Then: no hidden prefix is inserted, routing is preserved, and only explicit zero is measured.
		expect(payload).toMatchObject({
			instructions: "fixture-system",
			input: [{ role: "user", content: [{ type: "input_text", text: "fixture-prompt" }] }],
			prompt_cache_key: "stable-wire-key",
			store: false,
		});
		expect(payload).not.toHaveProperty("previous_response_id");
		// Then: the per-call session id does not split cache routing away from the stable key.
		expect(sessionHeader).toBe("stable-wire-key");
		expect(result.usage).toMatchObject({ cacheRead: cached ?? null, cacheReadReported: cached !== undefined });
	});
});
