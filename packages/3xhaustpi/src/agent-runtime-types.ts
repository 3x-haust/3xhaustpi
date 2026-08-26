import type { AgentToolApprovalRequest } from "./agent-approved-tools.ts";
import type { CacheWarmResult } from "./cache-warm-controller.ts";
import type { CodingTaskEvent, CodingTaskImage, CodingTaskPatchProposal, CodingTaskUsage } from "./coding-runtime.ts";

export interface AgentProviderEffectBoundaryRequest {
	readonly effectId: string;
	readonly kind: "provider";
}

export interface AgentEphemeralQuestionRequest {
	readonly projectRoot: string;
	readonly question: string;
	readonly context: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal: AbortSignal;
}

export interface AgentCompactConversationRequest {
	readonly projectRoot: string;
	readonly sessionId: string;
	readonly instructions?: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal: AbortSignal;
}

export interface AgentCompactConversationResult {
	readonly tokensBefore: number;
	readonly estimatedTokensAfter?: number;
}

export interface AgentCacheWarmRequest {
	readonly projectRoot: string;
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal: AbortSignal;
}

export type AgentCacheWarmResult = CacheWarmResult;

export interface AgentTaskRequest {
	readonly projectRoot: string;
	readonly objective: string;
	readonly provider?: string;
	readonly model?: string;
	readonly accountId?: string;
	readonly images?: readonly CodingTaskImage[];
	readonly sessionId?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal?: AbortSignal;
	readonly onEvent: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly requestToolApproval?: (request: AgentToolApprovalRequest) => Promise<boolean>;
	readonly delegationDepth?: number;
	readonly recordEffectBoundary?: (request: AgentProviderEffectBoundaryRequest) => Promise<void>;
	readonly onProviderPayload?: (payload: unknown) => void;
}

export interface AgentTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "aborted";
	readonly usage: CodingTaskUsage;
}
