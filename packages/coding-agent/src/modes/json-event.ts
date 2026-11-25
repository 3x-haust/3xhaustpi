import type { ServerToolContent, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

/** A server tool block on the wire: the provider's raw block (search results can be large) stays in `message_end`. */
type JsonServerTool = Omit<ServerToolContent, "raw">;

type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id: string; toolName: string }
	: T extends { type: "servertool_start"; partial: unknown }
		? WithoutPartial<T> & { id: string; toolName: string }
		: T extends { type: "servertool_end"; partial: unknown }
			? Omit<WithoutPartial<T>, "serverTool"> & { serverTool: JsonServerTool }
			: WithoutPartial<T>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	if (event.type === "servertool_start") {
		const block = event.partial.content[event.contentIndex];
		if (block?.type !== "serverTool") {
			throw new Error(`servertool_start content at index ${event.contentIndex} is not a server tool block`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: block.id, toolName: block.name };
	}

	if (event.type === "servertool_end") {
		const { partial: _partial, serverTool, ...deltaEvent } = event;
		const { raw: _raw, ...summary } = serverTool;
		return { ...deltaEvent, serverTool: summary };
	}

	if (!("partial" in event)) {
		return event;
	}

	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage,
 * tool-call ids, and tool names remain available because their size is constant.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}
