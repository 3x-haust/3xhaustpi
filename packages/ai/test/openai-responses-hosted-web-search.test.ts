import { afterEach, describe, expect, it } from "vitest";
import { resetHostedWebSearchRejections } from "../src/api/hosted-web-search.ts";
import {
	closeOpenAICodexWebSocketSessions,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Message, Model, ServerToolContent } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const question: Message = { role: "user", content: "What is pi?", timestamp: 1 };

const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_reasoning" };
const searching = { type: "web_search_call", id: "ws_1", status: "in_progress", action: { type: "search" } };
const searched = {
	type: "web_search_call",
	id: "ws_1",
	status: "completed",
	action: { type: "search", query: "pi coding agent", sources: [{ type: "url", url: "https://pi.example/docs" }] },
};
const answer = {
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "Pi is a coding agent.", annotations: [] }],
};

// Output items in the order the Responses API streams a hosted search; `response.web_search_call.*` progress events
// carry no content and are ignored.
const searchEvents = [
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
	{ type: "response.output_item.done", output_index: 0, item: reasoning },
	{ type: "response.output_item.added", output_index: 1, item: searching },
	{ type: "response.web_search_call.in_progress", output_index: 1, item_id: "ws_1" },
	{ type: "response.web_search_call.searching", output_index: 1, item_id: "ws_1" },
	{ type: "response.web_search_call.completed", output_index: 1, item_id: "ws_1" },
	{ type: "response.output_item.done", output_index: 1, item: searched },
	{ type: "response.output_item.added", output_index: 2, item: { ...answer, status: "in_progress", content: [] } },
	{
		type: "response.output_text.delta",
		output_index: 2,
		content_index: 0,
		item_id: "msg_1",
		delta: "Pi is a coding agent.",
	},
	{ type: "response.output_item.done", output_index: 2, item: answer },
	completed("resp_1"),
];

function completed(id: string) {
	return {
		type: "response.completed",
		response: {
			id,
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	};
}

function sse(events: { type: string }[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function harness(...responses: (() => Response)[]) {
	const bodies: Record<string, unknown>[] = [];
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
		const respond = responses[bodies.length - 1];
		if (!respond) throw new Error(`Unexpected request ${bodies.length}`);
		return respond();
	};
	return { bodies, fetch };
}

async function collect(stream: ReturnType<typeof streamOpenAIResponses>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

afterEach(() => {
	resetHostedWebSearchRejections();
	closeOpenAICodexWebSocketSessions();
});

describe("OpenAI Responses hosted web search", () => {
	it("declares the hosted tool, keeps web_search_call items and replays them like the Codex CLI", async () => {
		const { bodies, fetch } = harness(
			() => sse(searchEvents),
			() => sse([completed("resp_2")]),
		);
		const options = {
			apiKey: "test",
			fetch,
			hostedWebSearch: true,
			reasoningEffort: "low",
		} satisfies OpenAIResponsesOptions;

		const { events, result } = await collect(
			streamOpenAIResponses(model, normalizeContext({ messages: [question] }), options),
		);

		expect(bodies[0].tools).toEqual([{ type: "web_search" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.map((content) => content.type)).toEqual(["thinking", "serverTool", "text"]);
		expect(result.content[1]).toEqual({
			type: "serverTool",
			id: "ws_1",
			name: "web_search",
			phase: "call",
			input: { query: "pi coding agent" },
			sources: [{ url: "https://pi.example/docs" }],
			raw: searched,
		} satisfies ServerToolContent);
		expect(events.map((event) => event.type)).toContain("servertool_start");
		const ended = events.find((event) => event.type === "servertool_end");
		expect(ended?.type === "servertool_end" && ended.serverTool.input).toEqual({ query: "pi coding agent" });

		const followUp: Message = { role: "user", content: "More?", timestamp: 3 };
		await collect(
			streamOpenAIResponses(model, normalizeContext({ messages: [question, result, followUp] }), options),
		);
		const input = bodies[1].input as Record<string, unknown>[];
		expect(input.slice(1, 4)).toEqual([
			reasoning,
			{ type: "web_search_call", status: "completed", action: searched.action },
			expect.objectContaining({ type: "message", role: "assistant", id: "msg_1" }),
		]);
	});

	it("leaves the tool out unless switched on", async () => {
		const { bodies, fetch } = harness(() => sse([completed("resp_1")]));
		await collect(
			streamOpenAIResponses(model, normalizeContext({ messages: [question] }), { apiKey: "test", fetch }),
		);
		expect(bodies[0].tools).toBeUndefined();
	});

	it("drops the tool for the session and retries when the model rejects it", async () => {
		const rejection = () =>
			Response.json(
				{
					error: {
						message: "Tool 'web_search' is not supported with gpt-5-mini.",
						type: "invalid_request_error",
						param: "tools",
						code: null,
					},
				},
				{ status: 400 },
			);
		const { bodies, fetch } = harness(
			rejection,
			() => sse([completed("resp_1")]),
			() => sse([completed("resp_2")]),
		);
		const options = {
			apiKey: "test",
			fetch,
			hostedWebSearch: true,
			sessionId: "s1",
		} satisfies OpenAIResponsesOptions;

		const { result } = await collect(
			streamOpenAIResponses(model, normalizeContext({ messages: [question] }), options),
		);
		await collect(streamOpenAIResponses(model, normalizeContext({ messages: [question] }), options));

		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(["hosted_web_search_fallback"]);
		expect(bodies.map((body) => body.tools)).toEqual([[{ type: "web_search" }], undefined, undefined]);
	});
});

describe("OpenAI Codex hosted web search", () => {
	it("declares the hosted tool and tolerates web_search_call items", async () => {
		const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } })).toString("base64")}.bbb`;
		const bodies: Record<string, unknown>[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			// The SSE request body may be zstd-compressed; the uncompressed JSON is what the WebSocket would send.
			bodies.push(init?.body as unknown as Record<string, unknown>);
			const body = searchEvents.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n");
			return new Response(`${body}\n\n`, { headers: { "content-type": "text/event-stream" } });
		};
		const codex: Model<"openai-codex-responses"> = {
			...model,
			id: "gpt-5.1-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};
		const payloads: unknown[] = [];

		const stream = streamOpenAICodexResponses(codex, normalizeContext({ messages: [question] }), {
			apiKey: token,
			fetch,
			transport: "sse",
			hostedWebSearch: true,
			onPayload: (payload) => {
				payloads.push(payload);
				return undefined;
			},
		});
		const result = await stream.result();

		expect(bodies).toHaveLength(1);
		expect((payloads[0] as { tools?: unknown[] }).tools).toEqual([{ type: "web_search" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.map((content) => content.type)).toEqual(["thinking", "serverTool", "text"]);
		expect(result.content[1]).toMatchObject({ type: "serverTool", input: { query: "pi coding agent" } });
	});
});
