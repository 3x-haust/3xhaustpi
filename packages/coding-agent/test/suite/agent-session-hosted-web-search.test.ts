import { fauxAssistantMessage, type ServerToolContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createHarness, type Harness } from "./harness.ts";

const call: ServerToolContent = {
	type: "serverTool",
	id: "srvtoolu_1",
	name: "web_search",
	phase: "call",
	input: { query: "pi coding agent" },
	raw: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "pi coding agent" } },
};
const result: ServerToolContent = {
	type: "serverTool",
	id: "srvtoolu_1",
	name: "web_search",
	phase: "result",
	sources: [{ url: "https://pi.example/docs", title: "Pi docs" }],
	raw: {
		type: "web_search_tool_result",
		tool_use_id: "srvtoolu_1",
		content: [
			{ type: "web_search_result", url: "https://pi.example/docs", title: "Pi docs", encrypted_content: "x" },
		],
	},
};

describe("hosted web search session events", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("reports the search query and sources as message updates without the raw provider block", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage([call, result, { type: "text", text: "Pi is a coding agent." }])]);

		await harness.session.prompt("what is pi?");

		const updates = harness
			.eventsOfType("message_update")
			.map((event) => toJsonEvent(event).assistantMessageEvent)
			.filter((event) => event.type === "servertool_start" || event.type === "servertool_end");
		expect(updates).toEqual([
			{ type: "servertool_start", contentIndex: 0, id: "srvtoolu_1", toolName: "web_search" },
			{ type: "servertool_end", contentIndex: 0, serverTool: { ...call, raw: undefined } },
			{ type: "servertool_start", contentIndex: 1, id: "srvtoolu_1", toolName: "web_search" },
			{ type: "servertool_end", contentIndex: 1, serverTool: { ...result, raw: undefined } },
		]);
		const end = harness.eventsOfType("message_end").at(-1);
		expect(end?.message.role === "assistant" && end.message.content.slice(0, 2)).toEqual([call, result]);
	});
});
