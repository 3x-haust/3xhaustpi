import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
	isRejectedCacheTtlError,
	resetRejectedCacheTtlEndpoints,
	stream as streamAnthropic,
} from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function sseResponse(): Response {
	const events = [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			},
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function apiError(status: number, type: string, message: string): Error {
	return Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
}

/** A client whose first `failures` requests throw `error`, recording each request's cache TTLs. */
function fakeClient(failures: number, error: Error) {
	const ttls: Array<Array<string | undefined>> = [];
	const create = (params: unknown) => ({
		asResponse: async () => {
			const found: Array<string | undefined> = [];
			JSON.stringify(params, (key, value) => {
				if (key === "cache_control") found.push((value as { ttl?: string }).ttl);
				return value;
			});
			ttls.push(found);
			if (ttls.length <= failures) throw error;
			return sseResponse();
		},
	});
	const client = { messages: { create }, beta: { messages: { create } } } as unknown as Anthropic;
	return { client, ttls };
}

const context = normalizeContext({
	systemPrompt: "system",
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
});

const ttlError = () =>
	apiError(400, "invalid_request_error", "cache_control.ttl: Extra inputs are not permitted (ttl=1h)");

describe("Anthropic 1h cache TTL fallback", () => {
	afterEach(() => resetRejectedCacheTtlEndpoints());

	it("recognizes only 400 invalid_request_error responses that name the ttl", () => {
		expect(isRejectedCacheTtlError(ttlError())).toBe(true);
		expect(isRejectedCacheTtlError(apiError(400, "invalid_request_error", "messages: field required"))).toBe(false);
		expect(isRejectedCacheTtlError(apiError(500, "api_error", "ttl backend failure"))).toBe(false);
		expect(isRejectedCacheTtlError(new Error("ttl"))).toBe(false);
	});

	it("retries a rejected 1h ttl once with the default 5m ttl and records a diagnostic", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const { client, ttls } = fakeClient(1, ttlError());
		const result = await streamAnthropic(model, context, { client, cacheRetention: "long" }).result();

		expect(result.stopReason).toBe("stop");
		expect(ttls).toHaveLength(2);
		expect(ttls[0].length).toBeGreaterThan(0);
		expect(ttls[0].every((ttl) => ttl === "1h")).toBe(true);
		expect(ttls[1].length).toBe(ttls[0].length);
		expect(ttls[1].every((ttl) => ttl === undefined)).toBe(true);
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(["anthropic_cache_ttl_fallback"]);
	});

	it("remembers the rejecting endpoint so later requests skip the 1h attempt", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		await streamAnthropic(model, context, {
			client: fakeClient(1, ttlError()).client,
			cacheRetention: "long",
		}).result();

		const { client, ttls } = fakeClient(0, ttlError());
		const result = await streamAnthropic(model, context, { client, cacheRetention: "long" }).result();
		expect(result.stopReason).toBe("stop");
		expect(ttls).toHaveLength(1);
		expect(ttls[0].every((ttl) => ttl === undefined)).toBe(true);
		expect(result.diagnostics ?? []).toEqual([]);
	});

	it("keeps uncached requests uncached on a remembered endpoint", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		await streamAnthropic(model, context, {
			client: fakeClient(1, ttlError()).client,
			cacheRetention: "long",
		}).result();

		const { client, ttls } = fakeClient(0, ttlError());
		await streamAnthropic(model, context, { client, cacheRetention: "none" }).result();
		expect(ttls).toEqual([[]]);
	});

	it("does not retry when the 5m ttl was already in use or the error is unrelated", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const short = fakeClient(1, ttlError());
		const shortResult = await streamAnthropic(model, context, {
			client: short.client,
			cacheRetention: "short",
		}).result();
		expect(shortResult.stopReason).toBe("error");
		expect(short.ttls).toHaveLength(1);

		const other = fakeClient(1, apiError(400, "invalid_request_error", "messages: field required"));
		const otherResult = await streamAnthropic(model, context, {
			client: other.client,
			cacheRetention: "long",
		}).result();
		expect(otherResult.stopReason).toBe("error");
		expect(other.ttls).toHaveLength(1);
	});
});
