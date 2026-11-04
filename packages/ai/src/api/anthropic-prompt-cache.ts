import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/messages.js";

type CacheableBlock = Extract<ContentBlockParam, { type: "text" | "image" | "tool_result" | "tool_use" }>;
const CACHE_LOOKBACK_BLOCKS = 20;

/**
 * Reserve two conversation breakpoints alongside tools and the complete system.
 * Prefer the preceding message boundary (including assistant continuations) if
 * its lookback still covers the preceding user boundary. Otherwise keep that
 * user boundary explicit, so large newly generated tool batches cannot hide it.
 * With two slots and no previous-request state, not every old boundary can be
 * retained when both gaps exceed the server's lookback window.
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

	let markedLatest = false;
	let preceding: { block: CacheableBlock; position: number } | undefined;
	let blocksAfterMessage = 0;
	for (let i = params.messages.length - 1; i >= 0; i--) {
		const message = params.messages[i];
		if (typeof message.content === "string") {
			message.content = [{ type: "text", text: message.content }];
		}
		const blocks = message.content;
		let boundary: { block: CacheableBlock; position: number } | undefined;
		for (let j = blocks.length - 1; j >= 0; j--) {
			const block = blocks[j];
			if (
				block.type === "text" ||
				block.type === "image" ||
				block.type === "tool_result" ||
				block.type === "tool_use"
			) {
				boundary = { block, position: blocksAfterMessage + blocks.length - 1 - j };
				break;
			}
		}
		// Count all top-level blocks, including unmarkable thinking blocks.
		blocksAfterMessage += blocks.length;
		if (!boundary) continue;
		if (!markedLatest) {
			boundary.block.cache_control = cacheControl;
			markedLatest = true;
			continue;
		}
		preceding ??= boundary;
		if (message.role === "user") {
			const selected = boundary.position - preceding.position < CACHE_LOOKBACK_BLOCKS ? preceding : boundary;
			selected.block.cache_control = cacheControl;
			return;
		}
	}
	if (preceding) preceding.block.cache_control = cacheControl;
}
