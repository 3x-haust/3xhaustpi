import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type SessionInfo, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
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

export interface AgentConversationRewindPoint {
	readonly entryId: string;
	readonly prompt: string;
	readonly turn: number;
}

export interface AgentConversationFork {
	readonly selectedPrompt: string;
	readonly sessionId: string | null;
	readonly model: AgentConversation["model"];
	readonly thinkingLevel: AgentConversation["thinkingLevel"];
	readonly messages: AgentConversation["messages"];
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

export async function listAgentConversationRewindPoints(
	projectRoot: string,
	sessionId: string,
	sessionDir?: string,
): Promise<readonly AgentConversationRewindPoint[]> {
	const manager = await openAgentSessionManager(projectRoot, sessionId, sessionDir);
	let turn = 0;
	return manager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const prompt = contentText(entry.message.content).trim();
		if (!prompt) return [];
		turn += 1;
		return [{ entryId: entry.id, prompt, turn }];
	});
}

export async function forkAgentConversationAtUserTurn(
	projectRoot: string,
	sessionId: string,
	entryId: string,
	sessionDir?: string,
): Promise<AgentConversationFork> {
	const manager = await openAgentSessionManager(projectRoot, sessionId, sessionDir);
	const selected = manager.getEntries().find((entry) => entry.id === entryId);
	if (!selected || selected.type !== "message" || selected.message.role !== "user") {
		throw new Error("Conversation rewind point is unavailable");
	}
	const selectedPrompt = contentText(selected.message.content).trim();
	if (!selectedPrompt) throw new Error("Conversation rewind point has no prompt");
	if (selected.parentId) {
		const forkedPath = manager.createBranchedSession(selected.parentId);
		if (!forkedPath) throw new Error("Failed to create conversation branch");
		const conversation = await loadAgentConversation(projectRoot, manager.getSessionId(), manager.getSessionDir());
		return {
			selectedPrompt,
			sessionId: conversation.id,
			model: conversation.model,
			thinkingLevel: conversation.thinkingLevel,
			messages: conversation.messages,
		};
	}
	const original = await loadAgentConversation(projectRoot, sessionId, manager.getSessionDir());
	return {
		selectedPrompt,
		sessionId: null,
		model: original.model,
		thinkingLevel: original.thinkingLevel,
		messages: [],
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
