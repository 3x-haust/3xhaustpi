import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/messages.js";

type CacheableBlock = Extract<ContentBlockParam, { type: "text" | "image" | "tool_result" | "tool_use" }>;

/**
 * Keep the latest conversation boundary and the preceding user boundary explicit.
 * Anthropic only searches a limited number of blocks before each breakpoint; a
 * single moving marker can lose the previous request's cached prefix after a
 * large parallel tool batch. The caller reserves two of the four breakpoints
 * for tools and system (including the OAuth identity).
 */
export function applyAnthropicPromptCache(
	params: MessageCreateParamsStreaming,
	cacheControl: CacheControlEphemeral | undefined,
): void {
	if (!cacheControl) return;

	// A single system breakpoint covers both the OAuth identity and prompt.
	if (Array.isArray(params.system) && params.system.length > 0) {
		params.system[params.system.length - 1].cache_control = cacheControl;
	}

	const messages = params.messages;
	let markedLatest = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (markedLatest && message.role !== "user") continue;
		if (typeof message.content === "string") {
			message.content = [{ type: "text", text: message.content }];
		}
		const block = [...message.content]
			.reverse()
			.find(
				(candidate): candidate is CacheableBlock =>
					candidate.type === "text" ||
					candidate.type === "image" ||
					candidate.type === "tool_result" ||
					candidate.type === "tool_use",
			);
		if (!block) continue;
		block.cache_control = cacheControl;
		if (markedLatest) return;
		markedLatest = true;
	}
}
