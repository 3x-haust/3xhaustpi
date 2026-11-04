import type {
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_use", "tool_addition", "tool_removal"]);
type CacheableBlock = ContentBlockParam & { cache_control?: CacheControlEphemeral | null };
const CACHE_LOOKBACK_BLOCKS = 20;

/**
 * Reserve two conversation breakpoints alongside tools and the complete system.
 * Empty mid-conversation system messages (effort markers) carry no block and are skipped.
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

	// Use block content everywhere, so a user message serializes the same bytes whether or
	// not it currently carries a breakpoint and moving boundaries keep the cached prefix.
	for (const message of params.messages) {
		if (typeof message.content === "string") {
			message.content = [{ type: "text", text: message.content }];
		}
	}

	// A single system breakpoint covers both the OAuth identity and prompt.
	if (Array.isArray(params.system) && params.system.length > 0) {
		params.system[params.system.length - 1].cache_control = cacheControl;
	}

	let markedLatest = false;
	let preceding: { block: CacheableBlock; position: number } | undefined;
	let blocksAfterMessage = 0;
	for (let i = params.messages.length - 1; i >= 0; i--) {
		const message = params.messages[i];
		const blocks = message.content as ContentBlockParam[];
		let boundary: { block: CacheableBlock; position: number } | undefined;
		for (let j = blocks.length - 1; j >= 0; j--) {
			const block = blocks[j];
			if (CACHEABLE_BLOCK_TYPES.has(block.type)) {
				boundary = { block: block as CacheableBlock, position: blocksAfterMessage + blocks.length - 1 - j };
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
		// Mid-conversation system messages (tool changes) sit on the user side of a turn.
		if (message.role !== "assistant") {
			const selected = boundary.position - preceding.position < CACHE_LOOKBACK_BLOCKS ? preceding : boundary;
			selected.block.cache_control = cacheControl;
			return;
		}
	}
	if (preceding) preceding.block.cache_control = cacheControl;
}
