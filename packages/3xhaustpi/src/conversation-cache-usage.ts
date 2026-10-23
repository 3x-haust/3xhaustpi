/** Observe Codex's raw SSE usage before pi-ai replaces missing counts with zero. */
export function conversationCacheUsage(request: typeof globalThis.fetch = globalThis.fetch) {
	let cacheRead: number | null = null;
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
		if (!("response" in event) || typeof event.response !== "object" || event.response === null) return;
		const response = event.response;
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
	};
}
