import type { ConversationCitation } from "./coding-runtime-contracts.ts";

/** Observe Responses SSE metadata, raw usage and web-search citations before pi-ai drops them. */
export function conversationCacheUsage(request: typeof globalThis.fetch = globalThis.fetch) {
	let cacheRead: number | null = null;
	let responseModel: string | undefined;
	let reasoningEffort: string | undefined;
	let citations: readonly ConversationCitation[] = [];
	let webSearchCalls = 0;
	const observe = (frame: string): void => {
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch (error) {
			if (error instanceof SyntaxError) return;
			throw error;
		}
		if (typeof event !== "object" || event === null || !("type" in event)) return;
		if (!["response.completed", "response.done", "response.incomplete"].includes(String(event.type))) return;
		// Each terminal response replaces the previous observation, including missing usage.
		cacheRead = null;
		responseModel = undefined;
		reasoningEffort = undefined;
		citations = [];
		webSearchCalls = 0;
		if (!("response" in event) || typeof event.response !== "object" || event.response === null) return;
		const response = event.response;
		if ("output" in response && Array.isArray(response.output)) {
			webSearchCalls = response.output.filter((item) => isRecord(item) && item.type === "web_search_call").length;
			citations = outputCitations(response.output);
		}
		if ("model" in response && typeof response.model === "string" && response.model.length > 0)
			responseModel = response.model;
		if (
			"reasoning" in response &&
			typeof response.reasoning === "object" &&
			response.reasoning !== null &&
			"effort" in response.reasoning &&
			typeof response.reasoning.effort === "string" &&
			response.reasoning.effort.length > 0
		)
			reasoningEffort = response.reasoning.effort;
		if (!("usage" in response) || typeof response.usage !== "object" || response.usage === null) return;
		const usage = response.usage;
		if (
			!("input_tokens_details" in usage) ||
			typeof usage.input_tokens_details !== "object" ||
			usage.input_tokens_details === null
		)
			return;
		const details = usage.input_tokens_details;
		if (!("cached_tokens" in details)) return;
		const value = details.cached_tokens;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) cacheRead = value;
	};
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const response = await request(input, init);
		if (!response.ok || !response.body) return response;
		const decoder = new TextDecoder();
		let buffer = "";
		const consume = (text: string): void => {
			buffer += text;
			let boundary = /\r?\n\r?\n/u.exec(buffer);
			while (boundary) {
				observe(buffer.slice(0, boundary.index).replaceAll("\r\n", "\n"));
				buffer = buffer.slice(boundary.index + boundary[0].length);
				boundary = /\r?\n\r?\n/u.exec(buffer);
			}
		};
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					consume(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					consume(decoder.decode());
					if (buffer.trim()) observe(buffer.replaceAll("\r\n", "\n"));
				},
			}),
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return {
		fetch,
		get cacheRead(): number | null {
			return cacheRead;
		},
		get responseModel(): string | undefined {
			return responseModel;
		},
		get reasoningEffort(): string | undefined {
			return reasoningEffort;
		},
		get citations(): readonly ConversationCitation[] {
			return citations;
		},
		get webSearchCalls(): number {
			return webSearchCalls;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `url_citation` annotations of the final message, deduplicated by URL in first-cited order. */
function outputCitations(output: readonly unknown[]): readonly ConversationCitation[] {
	const byUrl = new Map<string, ConversationCitation>();
	for (const item of output) {
		if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
			for (const annotation of part.annotations) {
				if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
				const url = annotation.url;
				if (typeof url !== "string" || !/^https?:\/\//u.test(url) || byUrl.has(url)) continue;
				const title =
					typeof annotation.title === "string" && annotation.title.trim() ? annotation.title.trim() : undefined;
				byUrl.set(url, title === undefined ? { url } : { url, title });
			}
		}
	}
	return [...byUrl.values()];
}
