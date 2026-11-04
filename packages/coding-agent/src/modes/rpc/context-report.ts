/**
 * `get_context`: what the model receives on the next request, broken into the parts a client
 * can show (system prompt sections, appended text, context files, skills, tools, messages),
 * each with a token estimate. Read-only.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../../core/agent-session.ts";
import { estimateTokens, estimateWeightedChars } from "../../core/compaction/index.ts";
import { buildSystemPromptState } from "../../core/system-prompt.ts";
import type { RpcContextMessage, RpcContextReport, RpcContextTool } from "./rpc-types.ts";

const PREVIEW_CHARS = 160;

/** chars/4 with multi-byte text weighted, as compaction estimates it. */
const tokensOf = (text: string): number => Math.ceil(estimateWeightedChars(text) / 4);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "toolCall" && typeof block.name === "string") parts.push(`[${block.name}]`);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join(" ");
}

function preview(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

function summarizeMessage(message: AgentMessage): RpcContextMessage {
	const m = message as unknown as Record<string, unknown>;
	const role = String(m.role ?? "unknown");
	const out: RpcContextMessage = { role, tokens: estimateTokens(message), preview: "" };
	if (typeof m.toolName === "string") out.toolName = m.toolName;
	if (m.isError === true) out.isError = true;
	if (role === "assistant" && Array.isArray(m.content)) {
		const calls = (m.content as Array<Record<string, unknown>>)
			.filter((b) => b.type === "toolCall" && typeof b.name === "string")
			.map((b) => b.name as string);
		if (calls.length > 0) out.toolCalls = calls;
	}
	if (typeof m.summary === "string") out.preview = preview(m.summary);
	else if (typeof m.command === "string") out.preview = preview(m.command);
	else out.preview = preview(textOf(m.content));
	return out;
}

export function buildContextReport(session: AgentSession): RpcContextReport {
	const options = session.systemPromptOptions;
	const state = buildSystemPromptState(options);
	const sections = Object.entries(state.sections ?? {}).map(([name, text]) => ({
		name,
		text,
		tokens: tokensOf(text),
	}));
	const systemPrompt = session.systemPrompt;

	const active = new Set(session.getActiveToolNames());
	const hidden = new Set(options.hiddenTools);
	const tools: RpcContextTool[] = session.getAllTools().map((tool) => {
		const declaration = JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
		return {
			name: tool.name,
			description: tool.description,
			active: active.has(tool.name) && !hidden.has(tool.name),
			exposure: tool.exposure,
			...(tool.namespace ? { namespace: tool.namespace.name } : {}),
			sourceInfo: tool.sourceInfo,
			schemaTokens: tokensOf(declaration),
		};
	});

	const skills = options.skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		path: skill.filePath,
		modelInvocable: !skill.disableModelInvocation,
		sourceInfo: skill.sourceInfo,
	}));

	const contextFiles = options.contextFiles.map((file) => ({
		path: file.path,
		content: file.content,
		tokens: tokensOf(file.content),
	}));

	const appendSystemPrompt = session.resourceLoader
		.getAppendSystemPrompt()
		.map((text) => ({ text, tokens: tokensOf(text) }));

	const messages = session.messages.map(summarizeMessage);

	return {
		cwd: options.cwd,
		systemPrompt,
		systemPromptTokens: tokensOf(systemPrompt),
		forced: state.sections === undefined,
		sections,
		appendSystemPrompt,
		contextFiles,
		skills,
		tools,
		messages,
		contextUsage: session.getContextUsage(),
	};
}
