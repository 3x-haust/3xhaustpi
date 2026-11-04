/**
 * A prompt-cache key named after the request prefix rather than the session, so sessions that
 * open with the same system prompt and tools (a team of agents) land on one cache entry and a
 * new session's first call can read what another session already wrote.
 *
 * Only providers that route their cache by an explicit key (OpenAI-style `prompt_cache_key`)
 * use it; Anthropic caches by prefix content and ignores it.
 */

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";

/** Key for the system prompt and tool definitions of `context`, or undefined when it has neither. */
export function prefixCacheKey(context: Pick<Context, "systemPrompt" | "tools">): string | undefined {
	const systemPrompt = context.systemPrompt ?? "";
	const tools = context.tools ?? [];
	if (systemPrompt.length === 0 && tools.length === 0) return undefined;
	const hash = createHash("sha256")
		.update(systemPrompt)
		.update("\0")
		.update(
			JSON.stringify(
				tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
			),
		)
		.digest("hex");
	return `pfx-${hash.slice(0, 40)}`;
}
