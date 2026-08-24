import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { openAgentSessionManager } from "./agent-runtime-session-lookup.ts";
import type { ThreeXhaustState } from "./state.ts";
import type { TuiViewState } from "./tui-contract.ts";

export interface AgentConversationSummary {
	readonly id: string;
	readonly name?: string;
	readonly firstPrompt: string;
	readonly messageCount: number;
	readonly createdAt: string;
	readonly modifiedAt: string;
}

export interface AgentConversationMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface AgentConversation {
	readonly id: string;
	readonly name?: string;
	readonly model: { readonly provider: string; readonly modelId: string } | null;
	readonly thinkingLevel: NonNullable<TuiViewState["thinkingLevel"]>;
	readonly messages: readonly AgentConversationMessage[];
}

function thinkingLevel(value: string): AgentConversation["thinkingLevel"] {
	switch (value) {
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return value;
		default:
			return "medium";
	}
}

function summary(info: SessionInfo): AgentConversationSummary {
	return {
		id: info.id,
		...(info.name ? { name: info.name } : {}),
		firstPrompt: info.firstMessage,
		messageCount: info.messageCount,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
	};
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function conversationMessage(message: AgentMessage): AgentConversationMessage | undefined {
	if (!isMessageWithContent(message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
	const text = contentText(message.content).trim();
	return text ? { role: message.role, text } : undefined;
}

export async function listAgentConversationSessions(
	projectRoot: string,
	sessionDir?: string,
): Promise<readonly AgentConversationSummary[]> {
	return (await SessionManager.list(projectRoot, sessionDir)).map(summary);
}

export function resolveAgentConversationSession(
	sessions: readonly AgentConversationSummary[],
	selector: string,
): AgentConversationSummary | undefined {
	const numeric = Number.parseInt(selector, 10);
	if (String(numeric) === selector && numeric >= 1) return sessions[numeric - 1];
	const normalized = selector.toLowerCase();
	const matches = sessions.filter(
		(session) =>
			session.id.toLowerCase() === normalized ||
			session.id.toLowerCase().endsWith(normalized) ||
			session.name?.toLowerCase() === normalized ||
			session.firstPrompt.toLowerCase().includes(normalized),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export async function loadAgentConversation(
	projectRoot: string,
	sessionId: string,
	sessionDir?: string,
): Promise<AgentConversation> {
	const manager = await openAgentSessionManager(projectRoot, sessionId, sessionDir);
	const context = manager.buildSessionContext();
	return {
		id: manager.getSessionId(),
		...(manager.getSessionName() ? { name: manager.getSessionName() } : {}),
		model: context.model,
		thinkingLevel: thinkingLevel(context.thinkingLevel),
		messages: context.messages.flatMap((message) => {
			const item = conversationMessage(message);
			return item ? [item] : [];
		}),
	};
}

export async function quarantineInvalidAgentConversationHead(
	projectRoot: string,
	state: ThreeXhaustState,
	sessionDir?: string,
): Promise<string | undefined> {
	const head = state.readTuiConversationHead(projectRoot);
	if (!head.sessionId) return undefined;
	const sessions = await listAgentConversationSessions(projectRoot, sessionDir);
	if (sessions.some((session) => session.id === head.sessionId)) return undefined;
	state.quarantineTuiConversationHead(projectRoot, {
		expectedGeneration: head.generation,
		sessionId: head.sessionId,
		reason: "not a Pi conversation for this project",
	});
	return head.sessionId;
}
