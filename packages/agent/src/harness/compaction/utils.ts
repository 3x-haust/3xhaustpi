import { contentText, type Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file lists as summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;
const TOOL_ARGUMENT_MAX_CHARS = 512;
const EXACT_ARGUMENT_KEYS = new Set([
	"accountId",
	"childSessionId",
	"command",
	"objective",
	"parentToolCallId",
	"path",
	"pattern",
	"query",
	"sessionId",
	"taskId",
	"toolCallId",
	"workId",
]);

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	const headChars = Math.ceil(maxChars / 2);
	const tailChars = Math.floor(maxChars / 2);
	return `${text.slice(0, headChars)}\n\n[... ${truncatedChars} characters omitted ...]\n\n${text.slice(-tailChars)}`;
}

function stableDigest(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function compactToolArgument(key: string, value: unknown): string {
	const serialized = typeof value === "string" ? value : safeJsonStringify(value);
	if (EXACT_ARGUMENT_KEYS.has(key) && serialized.length <= TOOL_RESULT_MAX_CHARS) {
		return safeJsonStringify(value);
	}
	if (serialized.length <= TOOL_ARGUMENT_MAX_CHARS) return safeJsonStringify(value);
	return `[${serialized.length} chars digest=${stableDigest(serialized)}]`;
}

function formatToolArguments(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return compactToolArgument("value", value);
	return Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${key}=${compactToolArgument(key, entry)}`)
		.join(", ");
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "toolCall") {
					toolCalls.push(`${block.name}#${block.id}(${formatToolArguments(block.arguments)})`);
				}
			}

			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(
					`[Tool result name=${msg.toolName} id=${msg.toolCallId} status=${msg.isError ? "error" : "success"}]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`,
				);
			}
		}
	}

	return parts.join("\n\n");
}
