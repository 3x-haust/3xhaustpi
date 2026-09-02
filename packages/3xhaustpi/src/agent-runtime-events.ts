import type { StopReason } from "@earendil-works/pi-ai";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import type { CodingTaskEvent, CodingTaskUsage } from "./coding-runtime.ts";

const DELEGATED_AGENT_TOOL_NAMES = new Set(["delegate", "subagent"]);

function usageOf(message: {
	usage?: { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null };
}): CodingTaskUsage {
	const usage = message.usage ?? {};
	return {
		input: usage.input ?? null,
		output: usage.output ?? null,
		cacheRead: usage.cacheRead ?? null,
		cacheWrite: usage.cacheWrite ?? null,
	};
}

export interface AgentEventProjection {
	readonly listener: AgentSessionEventListener;
	readonly terminal: () => AgentTerminalState | undefined;
	readonly usage: () => CodingTaskUsage;
}

export interface AgentTerminalState {
	readonly errorMessage: string | undefined;
	readonly stopReason: StopReason;
	readonly textCharacters: number;
}

export function createAgentEventProjection(
	sessionId: string,
	onEvent: (event: CodingTaskEvent) => void,
): AgentEventProjection {
	let lastUsage: CodingTaskUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };
	let assistantStartedAt: number | undefined;
	let assistantTurn = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let terminal: AgentTerminalState | undefined;
	const toolStartedAt = new Map<string, number>();

	return {
		terminal: () => terminal,
		usage: () => lastUsage,
		listener: (event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStartedAt = performance.now();
				return;
			}
			if (event.type === "message_update" && event.message.role === "assistant") {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") onEvent({ type: "assistant.delta", text: update.delta });
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				const durationMs =
					assistantStartedAt === undefined ? 0 : Math.max(0, performance.now() - assistantStartedAt);
				const assistantText = event.message.content
					.flatMap((content) => (content.type === "text" ? [content.text] : []))
					.join("");
				terminal = {
					errorMessage: event.message.errorMessage,
					stopReason: event.message.stopReason,
					textCharacters: assistantText.trim().length,
				};
				if (assistantText.trim().length > 0) onEvent({ type: "assistant.message", text: assistantText });
				const usage = usageOf(event.message);
				inputTokens += usage.input ?? 0;
				outputTokens += usage.output ?? 0;
				cacheReadTokens += usage.cacheRead ?? 0;
				cacheWriteTokens += usage.cacheWrite ?? 0;
				lastUsage = {
					input: inputTokens,
					output: outputTokens,
					cacheRead: cacheReadTokens,
					cacheWrite: cacheWriteTokens,
				};
				assistantTurn += 1;
				onEvent({
					type: "model.completed",
					responseId: event.message.responseId ?? `response_${sessionId}_turn_${assistantTurn}`,
					usage,
					durationMs,
				});
				assistantStartedAt = undefined;
				return;
			}
			if (event.type === "tool_execution_start") {
				toolStartedAt.set(event.toolCallId, performance.now());
				onEvent({
					type: "work.started",
					workId: event.toolCallId,
					kind: DELEGATED_AGENT_TOOL_NAMES.has(event.toolName) ? "agent" : "tool",
					label: event.toolName,
				});
				return;
			}
			if (event.type === "tool_execution_end") {
				const completedAt = performance.now();
				const startedAt = toolStartedAt.get(event.toolCallId);
				toolStartedAt.delete(event.toolCallId);
				onEvent({
					type: "work.completed",
					workId: event.toolCallId,
					success: !event.isError,
					durationMs: startedAt === undefined ? 0 : Math.max(0, completedAt - startedAt),
					summary: `${event.toolName} ${event.isError ? "failed" : "done"}`,
				});
			}
		},
	};
}
