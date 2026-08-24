import type { AgentToolApprovalRequest } from "./agent-approved-tools.ts";
import type { CodingTaskEvent, CodingTaskPatchProposal, CodingTaskUsage } from "./coding-runtime.ts";

export interface AgentProviderEffectBoundaryRequest {
	readonly effectId: string;
	readonly kind: "provider";
}

export interface AgentTaskRequest {
	readonly projectRoot: string;
	readonly objective: string;
	readonly provider?: string;
	readonly model?: string;
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
