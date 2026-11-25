import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { resetHostedWebSearchRejections } from "../src/api/hosted-web-search.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Message, Model, ServerToolContent, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1000,
};

const lookup: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ key: Type.String() }),
};

const webSearchTool = { type: "web_search_20250305", name: "web_search" };

// Blocks in the shapes the Messages API streams for a web search (web search tool docs, "Streaming").
const serverToolUse = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} };
const searchResult = {
	type: "web_search_tool_result",
	tool_use_id: "srvtoolu_1",
	content: [
		{
			type: "web_search_result",
			url: "https://pi.example/docs",
			title: "Pi docs",
			encrypted_content: "enc_result_1",
			page_age: "April 30, 2026",
		},
	],
};
const citation = {
	type: "web_search_result_location",
	url: "https://pi.example/docs",
	title: "Pi docs",
	encrypted_index: "enc_index_1",
	cited_text: "Pi is a coding agent.",
};

type SseEvent = { type: string; [key: string]: unknown };

function sse(events: SseEvent[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function messageStart(id: string, inputTokens = 10): SseEvent {
	return {
		type: "message_start",
		message: { id, model: model.id, usage: { input_tokens: inputTokens, output_tokens: 0 } },
	};
}

function messageEnd(stopReason: string, outputTokens = 5): SseEvent[] {
	return [
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
		{ type: "message_stop" },
	];
}

function block(index: number, contentBlock: object, deltas: object[] = []): SseEvent[] {
	return [
		{ type: "content_block_start", index, content_block: contentBlock },
		...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
		{ type: "content_block_stop", index },
	];
}

function searchBlocks(first: number): SseEvent[] {
	return [
		...block(first, serverToolUse, [
			{ type: "input_json_delta", partial_json: '{"query":' },
			{ type: "input_json_delta", partial_json: '"pi coding agent"}' },
		]),
		...block(first + 1, searchResult),
	];
}

function harness(...responses: (() => Response)[]) {
	const payloads: MessageCreateParamsStreaming[] = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		payloads.push(JSON.parse(init?.body as string) as MessageCreateParamsStreaming);
		const respond = responses[payloads.length - 1];
		if (!respond) throw new Error(`Unexpected request ${payloads.length}`);
		return respond();
	};
	const options = {
		apiKey: "test-key",
		fetch,
		maxRetries: 0,
		cacheRetention: "none",
		hostedWebSearch: true,
	} satisfies AnthropicOptions;
	return { payloads, options };
}

function errorResponse(message: string): Response {
	return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 });
}

function context(messages: Message[], tools: Tool[] = []) {
	return normalizeContext({ systemPrompt: "Be brief.", tools, messages });
}

const question: Message = { role: "user", content: "What is pi?", timestamp: 1 };

async function collect(stream: ReturnType<typeof streamAnthropic>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

afterEach(() => resetHostedWebSearchRejections());

describe("Anthropic hosted web search", () => {
	it("keeps server tool blocks and citations, and replays them unchanged and in order", async () => {
		const { payloads, options } = harness(
			() =>
				sse([
					messageStart("msg_1"),
					...block(0, { type: "thinking", thinking: "", signature: "" }, [
						{ type: "thinking_delta", thinking: "Search first." },
						{ type: "signature_delta", signature: "sig_1" },
					]),
					...searchBlocks(1),
					...block(3, { type: "text", text: "", citations: null }, [
						{ type: "citations_delta", citation },
						{ type: "text_delta", text: "Pi is a coding agent." },
					]),
					...messageEnd("end_turn"),
				]),
			() => sse([messageStart("msg_2"), ...messageEnd("end_turn")]),
		);

		const { events, result } = await collect(streamAnthropic(model, context([question]), options));

		expect(payloads[0].tools).toEqual([webSearchTool]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.map((content) => content.type)).toEqual(["thinking", "serverTool", "serverTool", "text"]);
		const [, call, searched, text] = result.content as [unknown, ServerToolContent, ServerToolContent, unknown];
		expect(call).toMatchObject({
			id: "srvtoolu_1",
			name: "web_search",
			phase: "call",
			input: { query: "pi coding agent" },
		});
		expect(searched).toMatchObject({
			id: "srvtoolu_1",
			name: "web_search",
			phase: "result",
			sources: [{ url: "https://pi.example/docs", title: "Pi docs" }],
		});
		expect(text).toEqual({ type: "text", text: "Pi is a coding agent.", citations: [citation] });

		const ended = events.flatMap((event) => (event.type === "servertool_end" ? [event.serverTool] : []));
		expect(ended.map((serverTool) => [serverTool.phase, serverTool.input])).toEqual([
			["call", { query: "pi coding agent" }],
			["result", undefined],
		]);
		expect(events.filter((event) => event.type === "servertool_start").map((event) => event.contentIndex)).toEqual([
			1, 2,
		]);

		await collect(
			streamAnthropic(model, context([question, result, { role: "user", content: "More?", timestamp: 3 }]), options),
		);
		expect(payloads[1].messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Search first.", signature: "sig_1" },
				{ ...serverToolUse, input: { query: "pi coding agent" } },
				searchResult,
				{ type: "text", text: "Pi is a coding agent.", citations: [citation] },
			],
		});
	});

	it("continues a paused turn by resending the request with the paused content appended", async () => {
		const { payloads, options } = harness(
			() => sse([messageStart("msg_1", 10), ...searchBlocks(0), ...messageEnd("pause_turn", 5)]),
			() =>
				sse([
					messageStart("msg_2", 30),
					...block(0, { type: "text", text: "" }, [{ type: "text_delta", text: "Found it." }]),
					...messageEnd("end_turn", 7),
				]),
		);

		const { events, result } = await collect(streamAnthropic(model, context([question]), options));

		expect(payloads).toHaveLength(2);
		expect(payloads[1]).toEqual({
			...payloads[0],
			messages: [
				...payloads[0].messages,
				{ role: "assistant", content: [{ ...serverToolUse, input: { query: "pi coding agent" } }, searchResult] },
			],
		});
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("end_turn");
		expect(result.content.map((content) => content.type)).toEqual(["serverTool", "serverTool", "text"]);
		expect(result.usage).toMatchObject({ input: 40, output: 12 });
		expect(events.filter((event) => event.type === "start" || event.type === "done")).toHaveLength(2);
	});

	it("keeps a client tool call next to a pending server tool call and replays both before the tool result", async () => {
		const { payloads, options } = harness(
			() =>
				sse([
					messageStart("msg_1"),
					...block(0, serverToolUse, [{ type: "input_json_delta", partial_json: '{"query":"pi"}' }]),
					...block(1, { type: "tool_use", id: "toolu_1", name: "lookup", input: {} }, [
						{ type: "input_json_delta", partial_json: '{"key":"pi"}' },
					]),
					...messageEnd("tool_use"),
				]),
			() => sse([messageStart("msg_2"), ...messageEnd("end_turn")]),
		);

		const { result } = await collect(streamAnthropic(model, context([question], [lookup]), options));

		expect(toolNames(payloads[0])).toEqual(["lookup", "web_search"]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toMatchObject([
			{ type: "serverTool", phase: "call", input: { query: "pi" } },
			{ type: "toolCall", id: "toolu_1", name: "lookup", arguments: { key: "pi" } },
		]);

		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "lookup",
			content: [{ type: "text", text: "value" }],
			isError: false,
			timestamp: 2,
		};
		await collect(streamAnthropic(model, context([question, result, toolResult], [lookup]), options));
		expect(payloads[1].messages.slice(1)).toEqual([
			{
				role: "assistant",
				content: [
					{ ...serverToolUse, input: { query: "pi" } },
					{ type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "pi" } },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "value", is_error: false }],
			},
		]);
	});

	it("drops the tool for the session and retries when the provider rejects it", async () => {
		const { payloads, options } = harness(
			() => errorResponse("Web search is not enabled for this organization."),
			() => sse([messageStart("msg_1"), ...messageEnd("end_turn")]),
			() => sse([messageStart("msg_2"), ...messageEnd("end_turn")]),
			() => sse([messageStart("msg_3"), ...messageEnd("end_turn")]),
		);
		const session = { ...options, sessionId: "session-a" };

		const { events, result } = await collect(streamAnthropic(model, context([question]), session));

		expect(result.stopReason).toBe("stop");
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(payloads[0].tools).toEqual([webSearchTool]);
		expect(payloads[1].tools).toBeUndefined();
		expect(result.diagnostics).toMatchObject([
			{
				type: "hosted_web_search_fallback",
				error: { message: expect.stringContaining("Web search is not enabled") },
				details: { reason: "hosted_web_search_rejected" },
			},
		]);

		await collect(streamAnthropic(model, context([question]), session));
		expect(payloads[2].tools).toBeUndefined();
		await collect(streamAnthropic(model, context([question]), { ...options, sessionId: "session-b" }));
		expect(payloads[3].tools).toEqual([webSearchTool]);
	});

	it("does not retry errors that are not about the tool", async () => {
		const { payloads, options } = harness(() => errorResponse("messages: at least one message is required"));
		const { result } = await collect(streamAnthropic(model, context([question]), options));
		expect(result.stopReason).toBe("error");
		expect(payloads).toHaveLength(1);
	});

	it("is switched on by PI_HOSTED_WEB_SEARCH for first-party Anthropic only", async () => {
		const success = () => sse([messageStart("msg"), ...messageEnd("end_turn")]);
		const { payloads, options } = harness(success, success, success, success, success);
		const { hostedWebSearch: _unset, ...defaults } = options;

		await collect(streamAnthropic(model, context([question]), defaults));
		await collect(streamAnthropic(model, context([question]), { ...defaults, env: { PI_HOSTED_WEB_SEARCH: "1" } }));
		await collect(
			streamAnthropic({ ...model, provider: "openrouter" }, context([question]), {
				...defaults,
				env: { PI_HOSTED_WEB_SEARCH: "1" },
			}),
		);
		// A function tool of the same name would make the tool list invalid.
		const ownSearch: Tool = { ...lookup, name: "web_search" };
		await collect(streamAnthropic(model, context([question], [ownSearch]), options));
		await collect(
			streamAnthropic(model, context([question]), {
				...defaults,
				hostedWebSearch: false,
				env: { PI_HOSTED_WEB_SEARCH: "1" },
			}),
		);

		expect(
			payloads.map((payload) =>
				payload.tools?.some((tool) => "name" in tool && tool.name === "web_search" && "type" in tool),
			),
		).toEqual([undefined, true, undefined, false, undefined]);
	});

	it("keeps the server tool name and type with Claude subscription OAuth tokens", async () => {
		const { payloads, options } = harness(() =>
			sse([
				messageStart("msg_1"),
				...searchBlocks(0),
				...block(2, { type: "tool_use", id: "toolu_1", name: "Read", input: {} }, [
					{ type: "input_json_delta", partial_json: '{"key":"x"}' },
				]),
				...messageEnd("tool_use"),
			]),
		);
		const read: Tool = { ...lookup, name: "read" };

		const { result } = await collect(
			streamAnthropic(model, context([question], [read]), { ...options, apiKey: "sk-ant-oat01-test" }),
		);

		expect(toolNames(payloads[0])).toEqual(["Read", "web_search"]);
		expect(payloads[0].tools?.[1]).toEqual(webSearchTool);
		expect(payloads[0].system).toMatchObject([
			{ text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{},
		]);
		expect(result.content).toMatchObject([
			{ type: "serverTool", name: "web_search" },
			{ type: "serverTool", name: "web_search" },
			{ type: "toolCall", name: "read" },
		]);
	});

	it("drops a server tool call left without a result by the pause limit once the turn is over", async () => {
		const { payloads, options } = harness(() => sse([messageStart("msg"), ...messageEnd("end_turn")]));
		const paused = assistant([
			{ type: "text", text: "Searching." },
			{
				type: "serverTool",
				id: "srvtoolu_9",
				name: "web_search",
				phase: "call",
				input: { query: "x" },
				raw: { ...serverToolUse, id: "srvtoolu_9", input: { query: "x" } },
			},
		]);

		await collect(
			streamAnthropic(model, context([question, paused, { role: "user", content: "Go on", timestamp: 3 }]), options),
		);

		expect(payloads[0].messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Searching." }] });
	});

	it("drops server tool blocks for other providers and APIs", () => {
		const searched = assistant([
			{ type: "serverTool", id: "srvtoolu_1", name: "web_search", phase: "result", raw: searchResult },
			{ type: "text", text: "Answer", citations: [citation] },
		]);
		const openai: Model<"openai-responses"> = { ...model, api: "openai-responses", provider: "openai", id: "gpt-5" };

		const [, converted] = transformMessages([question, searched], openai);

		expect((converted as AssistantMessage).content).toEqual([{ type: "text", text: "Answer" }]);
		const [, sameApi] = transformMessages([question, searched], { ...model, id: "claude-sonnet-5-5" });
		expect((sameApi as AssistantMessage).content[0]).toMatchObject({ type: "serverTool" });
	});
});

function toolNames(payload: MessageCreateParamsStreaming): string[] | undefined {
	return payload.tools?.map((tool) => ("name" in tool ? tool.name : tool.type));
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}
