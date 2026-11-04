import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { applyAnthropicPromptCache } from "../src/api/anthropic-prompt-cache.ts";

const cacheControl: CacheControlEphemeral = { type: "ephemeral", ttl: "1h" };

function request(messages: MessageParam[], oauth = false): MessageCreateParamsStreaming {
	return {
		model: "offline-fixture",
		max_tokens: 1,
		stream: true,
		system: [
			...(oauth ? [{ type: "text" as const, text: "OAuth identity" }] : []),
			{ type: "text", text: "Stable system prompt" },
		],
		tools: [{ name: "read", input_schema: { type: "object" }, cache_control: cacheControl }],
		messages,
	};
}

function markedBlocks(params: MessageCreateParamsStreaming): ContentBlockParam[] {
	return params.messages.flatMap((message) =>
		typeof message.content === "string" ? [] : message.content.filter((block) => "cache_control" in block),
	);
}

describe("Anthropic prompt cache breakpoints (pure payload fixtures, no provider calls)", () => {
	it.each([false, true])("uses at most four breakpoints, including OAuth=%s", (oauth) => {
		const params = request(
			[
				{ role: "user", content: "first" },
				{ role: "assistant", content: "reply" },
				{ role: "user", content: "second" },
			],
			oauth,
		);
		applyAnthropicPromptCache(params, cacheControl);

		expect(markedBlocks(params)).toHaveLength(2);
		const system = Array.isArray(params.system) ? params.system : [];
		expect(system.filter((block) => block.cache_control)).toHaveLength(1);
		expect(system.at(-1)?.cache_control).toEqual(cacheControl);
		expect(params.tools?.filter((tool) => "cache_control" in tool && tool.cache_control)).toHaveLength(1);
	});

	it("keeps the previous request's boundary explicit beyond a 20-block lookback", () => {
		const previousUser: MessageParam = { role: "user", content: [{ type: "text", text: "first" }] };
		const previous = request([structuredClone(previousUser)]);
		applyAnthropicPromptCache(previous, cacheControl);
		const parallelCalls: ContentBlockParam[] = Array.from({ length: 24 }, (_, index) => ({
			type: "tool_use",
			id: `call_${index}`,
			name: "read",
			input: { path: `file_${index}` },
		}));
		const results: ContentBlockParam[] = parallelCalls.map((_, index) => ({
			type: "tool_result",
			tool_use_id: `call_${index}`,
			content: "result",
		}));
		const next = request([
			structuredClone(previousUser),
			{ role: "assistant", content: parallelCalls },
			{ role: "user", content: results },
		]);
		applyAnthropicPromptCache(next, cacheControl);

		// The exact previously-written prefix is still an explicit lookup point.
		expect(JSON.stringify(next.messages[0])).toBe(JSON.stringify(previous.messages[0]));
		expect(markedBlocks(next)).toEqual([
			{ type: "text", text: "first", cache_control: cacheControl },
			{ type: "tool_result", tool_use_id: "call_23", content: "result", cache_control: cacheControl },
		]);
		expect(parallelCalls.every((block) => !("cache_control" in block))).toBe(true);
	});

	it("marks assistant continuation text, not trailing thinking blocks", () => {
		const thinking: ContentBlockParam = { type: "thinking", thinking: "reason", signature: "signature" };
		const params = request([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "partial" }, thinking] },
		]);
		applyAnthropicPromptCache(params, cacheControl);

		expect(markedBlocks(params)).toHaveLength(2);
		expect(markedBlocks(params).at(-1)).toMatchObject({ type: "text", text: "partial" });
		expect(thinking).not.toHaveProperty("cache_control");
	});

	it("skips thinking-only messages and marks tool-use continuations", () => {
		const params = request([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] },
			{ role: "assistant", content: [{ type: "redacted_thinking", data: "signature" }] },
		]);
		applyAnthropicPromptCache(params, cacheControl);

		expect(markedBlocks(params).map((block) => block.type)).toEqual(["text", "tool_use"]);
	});

	it("supports image boundaries without annotating nested tool-result content", () => {
		const params = request([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "result" }] },
			{
				role: "user",
				content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }],
			},
		]);
		applyAnthropicPromptCache(params, cacheControl);

		expect(markedBlocks(params).map((block) => block.type)).toEqual(["tool_result", "image"]);
	});

	it("marks only the two newest boundaries in a longer conversation", () => {
		const params = request([
			{ role: "user", content: "one" },
			{ role: "assistant", content: "reply" },
			{ role: "user", content: "two" },
			{ role: "assistant", content: "reply" },
			{ role: "user", content: "three" },
		]);
		applyAnthropicPromptCache(params, cacheControl);

		expect(markedBlocks(params)).toEqual([
			{ type: "text", text: "two", cache_control: cacheControl },
			{ type: "text", text: "three", cache_control: cacheControl },
		]);
	});

	it("does not add markers when caching is disabled", () => {
		const params = request([{ role: "user", content: "first" }]);
		params.tools = [];
		const before = JSON.stringify(params);
		applyAnthropicPromptCache(params, undefined);

		expect(JSON.stringify(params)).toBe(before);
	});

	it("handles empty conversations and an OAuth identity without a custom prompt", () => {
		const params = request([], true);
		params.system = [{ type: "text", text: "OAuth identity" }];
		applyAnthropicPromptCache(params, cacheControl);

		expect(params.system[0].cache_control).toEqual(cacheControl);
		expect(markedBlocks(params)).toEqual([]);
	});
});
