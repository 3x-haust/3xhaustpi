import type { ExecutionGraph } from "./execution-graph.ts";

export interface TuiDispatchBinding {
	readonly version: 1;
	readonly conversationGeneration: number;
	readonly sessionId: string | null;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface TuiConversationHead {
	readonly generation: number;
	readonly sessionId: string | null;
}

export interface TuiRequestImage {
	readonly data: string;
	readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface TuiPromotionSource {
	readonly kind: "side" | "btw";
	readonly sourceId: string;
	readonly question: string;
	readonly answer: string;
	readonly completedAt: string;
}

export interface TuiPromotionPayload {
	readonly version: 1;
	readonly source: TuiPromotionSource;
}

export interface CompareAndSwapTuiConversationHeadInput {
	readonly expectedGeneration: number;
	readonly sessionId: string | null;
}

export interface PublishTuiConversationSessionInput extends TuiRequestLease {
	readonly projectPath: string;
	readonly expectedGeneration: number;
	readonly sessionId: string;
	readonly now?: string;
}

export interface QuarantineTuiConversationHeadInput {
	readonly expectedGeneration: number;
	readonly sessionId: string;
	readonly reason: string;
}

export interface QuarantinedTuiSession {
	readonly sessionId: string;
	readonly generation: number;
	readonly reason: string;
	readonly quarantinedAt: string;
}

export interface TuiRequest {
	readonly id: string;
	readonly projectPath: string;
	readonly objective: string;
	readonly images?: readonly TuiRequestImage[];
	readonly position: number;
	readonly status: "queued" | "running" | "completed" | "failed";
	readonly createdAt: string;
	readonly binding: TuiDispatchBinding | null;
	readonly promotion?: TuiPromotionPayload;
}

export interface ClaimedTuiRequest extends TuiRequest {
	readonly status: "running";
	readonly ownerId: string;
	readonly leaseEpoch: number;
}

export interface EnqueueTuiRequestInput {
	readonly requestId: string;
	readonly projectPath: string;
	readonly fingerprint: string;
	readonly objective: string;
	readonly images?: readonly TuiRequestImage[];
	readonly binding?: TuiDispatchBinding;
	readonly promotion?: TuiPromotionPayload;
}

export interface ClaimTuiRequestOptions {
	readonly ownerId: string;
	readonly requestId?: string;
	readonly now?: string;
	readonly leaseMs?: number;
}

export interface TuiRequestLease {
	readonly ownerId: string;
	readonly leaseEpoch: number;
}

export interface RenewTuiRequestLeaseInput extends TuiRequestLease {
	readonly now: string;
	readonly leaseMs: number;
}

export interface CompleteTuiRequestInput extends TuiRequestLease {
	readonly now?: string;
}

export type TuiRequestCompletionStatus = "completed" | "failed" | "canceled";

export interface RecordTuiExecutionEventInput extends TuiRequestLease {
	readonly now?: string;
}

export interface RecordTuiRequestEffectInput extends TuiRequestLease {
	readonly effectId: string;
	readonly now?: string;
}

export interface TuiExecutionProjection {
	readonly requestId: string;
	readonly objective: string;
	readonly status: "queued" | "running" | "completed" | "failed";
	readonly graph: ExecutionGraph;
}

export interface TuiRequestRow {
	readonly request_id: string;
	readonly canonical_path: string;
	readonly objective: string;
	readonly images_json: string | null;
	readonly position: number;
	readonly status: TuiRequest["status"];
	readonly created_at: string;
	readonly binding_version: number | null;
	readonly conversation_generation: number | null;
	readonly session_id: string | null;
	readonly provider: string | null;
	readonly model: string | null;
	readonly account_id: string | null;
	readonly thinking_level: string | null;
	readonly promotion_kind: string | null;
	readonly promotion_id: string | null;
	readonly promotion_json: string | null;
}

export interface RunningTuiRequestRow {
	readonly status: string;
	readonly owner_id: string | null;
	readonly lease_epoch: number;
	readonly lease_expires_at: string | null;
	readonly effect_id: string | null;
	readonly execution_sequence: number;
	readonly execution_snapshot: string | null;
}
