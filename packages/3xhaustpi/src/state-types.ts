export interface ResumeCheckpoint {
	readonly sessionId: string;
	readonly projectPath: string;
	readonly payload: string;
	readonly requestId: string;
	readonly requestPayload: string;
	readonly fingerprint: string;
	readonly generation: number;
	readonly outboxState: "queued" | "dispatching" | "accepted" | "settled" | "indeterminate";
	readonly updatedAt: string;
}

export type ExplicitResumeClaim =
	| { readonly kind: "checkpoint"; readonly checkpoint: ResumeCheckpoint }
	| { readonly kind: "restart"; readonly checkpoint: ResumeCheckpoint };

export interface BeginRunInput {
	readonly projectId: string;
	readonly projectPath: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly fingerprint: string;
	readonly payload: string;
	readonly checkpoint: string;
	readonly generation: number;
}

export interface WorkspaceSnapshot {
	readonly projects: readonly {
		readonly path: string;
		readonly createdAt: string;
		readonly chatCount: number;
		readonly activeChatCount: number;
	}[];
	readonly chats: readonly {
		readonly id: string;
		readonly status: string;
		readonly updatedAt: string;
		readonly objective: string;
	}[];
	readonly requests: readonly { readonly id: string; readonly status: string; readonly position: number }[];
	readonly patches: readonly { readonly id: string; readonly state: string; readonly updatedAt: string }[];
}
