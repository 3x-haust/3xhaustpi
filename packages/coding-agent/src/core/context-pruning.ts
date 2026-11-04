/**
 * Clears old, large tool results from model context before compaction is needed.
 *
 * Problem: a session that reads a dozen files keeps every file body in context. Each request
 * resends them, and compaction runs early, which replaces exact history with a summary.
 * Example: 40 reads of 4K tokens each are 160K tokens that the model rarely looks at again.
 *
 * Solution: replace each such result with a short pointer to a file that holds its text, using
 * append-only context edits. The edits are persisted, so later requests share the new prefix.
 *
 * Clearing changes the prompt prefix from the first cleared result onward, so the provider cache
 * must be rewritten from there. That is free when the cache already expired (the user paused
 * longer than its lifetime). While the cache is warm, clearing only pays off when it defers a
 * compaction, which rewrites everything anyway, so it waits until context is close to the
 * compaction threshold. Each clear removes at least `minSavingsTokens`, so the cache breaks rarely.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "./compaction/compaction.ts";
import type { ProjectedSessionEntry, SessionEntry } from "./session-manager.ts";

export interface ContextPruningSettings {
	enabled: boolean;
	/** Tool results inside this many most recent context tokens are kept. */
	protectRecentTokens: number;
	/** Clear only when one batch removes at least this many tokens. */
	minSavingsTokens: number;
}

/** Results smaller than this are cheaper to keep than to replace with a pointer. */
const MIN_RESULT_TOKENS = 500;
/** With a warm cache, clear only once context reaches this share of the compaction threshold. */
const WARM_CACHE_PRESSURE_RATIO = 0.8;

export interface StaleToolResult {
	entryId: string;
	message: ToolResultMessage;
	tokens: number;
}

export interface SelectStaleToolResultsOptions {
	entries: ProjectedSessionEntry[];
	branch: SessionEntry[];
	settings: ContextPruningSettings;
	contextTokens: number;
	compactionThreshold: number;
	cacheWarm: boolean;
}

function isTextOnlyToolResult(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult" && message.content.every((block) => block.type === "text");
}

/** Path argument of each tool call, so skill files the model loaded on purpose are never cleared. */
function collectToolCallPaths(entries: ProjectedSessionEntry[]): Map<string, string> {
	const paths = new Map<string, string>();
	for (const entry of entries) {
		for (const message of entry.messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const path = (block.arguments as { path?: unknown }).path;
				if (typeof path === "string") paths.set(block.id, path);
			}
		}
	}
	return paths;
}

/** Pick the tool results to clear, oldest first, or none if the batch is not worth a cache break. */
export function selectStaleToolResults(options: SelectStaleToolResultsOptions): StaleToolResult[] {
	const { entries, branch, settings, contextTokens, compactionThreshold, cacheWarm } = options;
	if (!settings.enabled) return [];
	if (cacheWarm && contextTokens < compactionThreshold * WARM_CACHE_PRESSURE_RATIO) return [];

	const edited = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "context_edit") edited.add(entry.targetId);
	}

	// Walk back from the newest entry to find where the protected tail starts. Long autonomous
	// runs follow a single user message, so protection counts tokens, not user turns.
	let protectedFrom = entries.length;
	let recentTokens = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		for (const message of entries[i].messages) recentTokens += estimateTokens(message);
		if (recentTokens > settings.protectRecentTokens) break;
		protectedFrom = i;
	}

	const toolCallPaths = collectToolCallPaths(entries);
	const candidates: StaleToolResult[] = [];
	let savings = 0;
	for (let i = 0; i < protectedFrom; i++) {
		const entry = entries[i];
		const source = entry.sourceEntry;
		if (source.type !== "message" || edited.has(source.id) || entry.messages.length !== 1) continue;
		const message = entry.messages[0];
		if (!isTextOnlyToolResult(message)) continue;
		const path = toolCallPaths.get(message.toolCallId);
		if (path && /(^|[\\/])SKILL\.md$/i.test(path)) continue;
		const tokens = estimateTokens(message);
		if (tokens < MIN_RESULT_TOKENS) continue;
		candidates.push({ entryId: source.id, message, tokens });
		savings += tokens;
	}
	return savings >= settings.minSavingsTokens ? candidates : [];
}

/** Text that replaces a cleared result. It names the file so the model can read it back. */
export function formatClearedToolResult(message: ToolResultMessage, savedPath: string | undefined): string {
	const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	const lines = text.length === 0 ? 0 : text.split("\n").length;
	const size = `${lines} lines, ${text.length} chars`;
	const where = savedPath
		? `The full text is saved at ${savedPath}; read that file if you need it again.`
		: "Run the tool again if you need it.";
	return `[Old ${message.toolName} result cleared to save context (${size}). ${where} The output was not empty; do not guess its content.]`;
}
