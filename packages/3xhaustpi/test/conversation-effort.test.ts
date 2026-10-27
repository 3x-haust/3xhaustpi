import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConversation } from "../src/coding-runtime-provider.ts";
import type { ConversationInput } from "../src/runtime-entry.ts";

afterEach(() => vi.unstubAllGlobals());

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

function wireFixture(metadata: Readonly<Record<string, unknown>> = {}) {
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
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	};
	vi.stubGlobal("fetch", fetch);
	return requests;
}

describe("conversation reasoning effort at the HTTP boundary", () => {
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
