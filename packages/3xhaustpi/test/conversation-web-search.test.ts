import { describe, expect, it } from "vitest";
import { conversationCacheUsage } from "../src/conversation-cache-usage.ts";

describe("conversation web search observation", () => {
	it("reports cited sources and hosted search calls from the terminal response", async () => {
		// Given: a Codex response that searched twice and cited one page twice and another once.
		const response = {
			output: [
				{ type: "web_search_call", status: "completed" },
				{ type: "web_search_call", status: "completed" },
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "answer",
							annotations: [
								{ type: "url_citation", url: "https://example.com/a", title: " A " },
								{ type: "url_citation", url: "https://example.com/a", title: "A again" },
								{ type: "url_citation", url: "https://example.com/b" },
								{ type: "url_citation", url: "javascript:alert(1)", title: "bad" },
								{ type: "file_citation", url: "https://example.com/c" },
							],
						},
					],
				},
			],
		};
		const wire = `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
		const observation = conversationCacheUsage(async () => new Response(wire));

		// When: the provider consumes the stream.
		await (await observation.fetch("https://example.invalid")).text();

		// Then: only http(s) url citations remain, deduplicated in cited order.
		expect(observation.webSearchCalls).toBe(2);
		expect(observation.citations).toEqual([
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b" },
		]);
	});

	it("reports nothing when the response did not search", async () => {
		const wire = `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [] }] } })}\n\n`;
		const observation = conversationCacheUsage(async () => new Response(wire));
		await (await observation.fetch("https://example.invalid")).text();
		expect(observation.webSearchCalls).toBe(0);
		expect(observation.citations).toEqual([]);
	});
});
