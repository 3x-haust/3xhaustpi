import { describe, expect, it } from "vitest";
import { conversationCacheUsage } from "../src/conversation-cache-usage.ts";

describe("raw conversation cache usage", () => {
	it.each([
		[{ cached_tokens: 0 }, 0],
		[{ cached_tokens: 2048 }, 2048],
		[{}, null],
		[{ cached_tokens: null }, null],
		[{ cached_tokens: -1 }, null],
		[{ cached_tokens: "0" }, null],
	] as const)("preserves provider evidence %j", async (details, expected) => {
		// Given: a real byte stream split across arbitrary network chunks.
		const wire = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens_details: details } } })}\r\n\r\n`;
		const bytes = new TextEncoder().encode(wire);
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (let offset = 0; offset < bytes.length; offset += 7)
							controller.enqueue(bytes.slice(offset, offset + 7));
						controller.close();
					},
				}),
			);
		const observation = conversationCacheUsage(fetch);
		// When: the downstream provider consumes the wrapped response.
		const response = await observation.fetch("https://example.invalid");
		const received = await response.text();
		// Then: the wire is unchanged and missing fields never become measured zero.
		expect(received).toBe(wire);
		expect(observation.cacheRead).toBe(expected);
	});

	it("ignores nonterminal and malformed events", async () => {
		// Given: an informational event containing unrelated usage.
		const wire =
			'data: {"type":"response.created","response":{"usage":{"input_tokens_details":{"cached_tokens":9}}}}\n\ndata: invalid\n\ndata: [DONE]\n\n';
		const observation = conversationCacheUsage(async () => new Response(wire));
		// When: the stream finishes without a terminal usage report.
		await (await observation.fetch("https://example.invalid")).text();
		// Then: no report is inferred.
		expect(observation.cacheRead).toBeNull();
	});

	it.each(["response.done", "response.incomplete"])("resets observations on a later %s boundary", async (type) => {
		// Given: an earlier terminal response reports fields the final response omits.
		const events = [
			{ type: "response.completed", response: { model: "reported-model", reasoning: { effort: "low" } } },
			{ type, response: { model: null, reasoning: { effort: null } } },
		];
		const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		const observation = conversationCacheUsage(async () => new Response(wire));
		// When: the downstream consumes both terminal frames.
		await (await observation.fetch("https://example.invalid")).text();
		// Then: absent final fields never inherit or guess earlier values.
		expect(observation.responseModel).toBeUndefined();
		expect(observation.reasoningEffort).toBeUndefined();
	});
});
