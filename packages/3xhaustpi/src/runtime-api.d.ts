export interface CodingTaskUsage {
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite?: number | null;
}

export interface CodingTaskPatchProposal {
	readonly patchId: string;
	readonly targetRevision: string;
	readonly diff: string;
	readonly files: readonly string[];
}

export type CodingTaskEvent =
	| {
			readonly type: "session.started";
			readonly runtimeKind: "native-agent" | "semantic-checkpoint";
			readonly sessionId: string;
			readonly provider: string;
			readonly model: string;
			readonly objective: string;
	  }
	| {
			readonly type: "model.completed";
			readonly responseId: string;
			readonly usage: CodingTaskUsage;
			readonly durationMs: number;
	  }
	| {
			readonly type: "capability.started";
			readonly capability: string;
	  }
	| {
			readonly type: "capability.completed";
			readonly capability: string;
			readonly success: boolean;
			readonly durationMs: number;
			readonly summary: string;
	  }
	| {
			readonly type: "work.started";
			readonly workId: string;
			readonly parentWorkId?: string;
			readonly kind: "tool" | "agent";
			readonly label: string;
	  }
	| {
			readonly type: "work.completed";
			readonly workId: string;
			readonly success: boolean;
			readonly durationMs: number;
			readonly summary: string;
	  }
	| ({ readonly type: "patch.proposed" } & CodingTaskPatchProposal)
	| {
			readonly type: "patch.decision";
			readonly patchId: string;
			readonly approved: boolean;
	  }
	| {
			readonly type: "diagnostics.completed";
			readonly success: boolean;
			readonly command: string;
			readonly output: string;
			readonly durationMs: number;
	  }
	| {
			readonly type: "assistant.delta";
			readonly text: string;
	  }
	| {
			readonly type: "assistant.message";
			readonly text: string;
	  }
	| {
			readonly type: "session.completed";
			readonly sessionId: string;
			readonly outcome: "completed" | "rejected";
			readonly decision: string;
			readonly usage: CodingTaskUsage;
	  }
	| {
			readonly type: "session.failed";
			readonly sessionId: string;
			readonly message: string;
	  };

export interface CodingTaskResourceOptions {
	readonly enabled: boolean;
	readonly allowProjectHooks?: boolean;
	readonly userRoot?: string;
	readonly builtinRoot?: string;
}

export interface CodingTaskInput {
	readonly projectRoot: string;
	readonly objective: string;
	readonly images?: readonly CodingTaskImage[];
	readonly approve: boolean;
	readonly statePath?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly credential?: string;
	readonly sessionId?: string;
	/** Use only non-executing diagnostics and never run validation scripts from the project. */
	readonly strict?: boolean;
	readonly preserveProviderSession?: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: CodingTaskEvent) => void;
	readonly recordEffectBoundary?: (effect: CodingTaskEffectBoundary) => Promise<void>;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly resources?: CodingTaskResourceOptions;
}

export interface CodingTaskEffectBoundary {
	readonly effectId: string;
	readonly kind: "provider";
}

export interface CodingTaskImage {
	readonly data: string;
	readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export interface ResumeCodingTaskInput {
	readonly approve: boolean;
	readonly statePath?: string;
	readonly sessionId?: string;
	readonly projectRoot?: string;
	readonly credential?: string;
	/** Use only non-executing diagnostics and never run validation scripts from the project. */
	readonly strict?: boolean;
	readonly preserveProviderSession?: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: CodingTaskEvent) => void;
	readonly recordEffectBoundary?: (effect: CodingTaskEffectBoundary) => Promise<void>;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly resources?: CodingTaskResourceOptions;
}

export interface CodingTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "rejected";
	readonly decision: string;
	readonly usage: CodingTaskUsage;
	readonly patchId?: string;
	readonly diagnostics?: {
		readonly success: boolean;
		readonly command: string;
		readonly output: string;
	};
}

export interface ConversationInput {
	readonly provider?: string;
	readonly model?: string;
	/** Model-supported effort, encoded with the provider's native controls. Omit for provider defaults. */
	readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	readonly credential?: string;
	readonly system: string;
	readonly prompt: string;
	readonly images?: readonly CodingTaskImage[];
	readonly sessionId?: string;
	/** Stable cache affinity, clamped to 64 Unicode code points. Defaults to sessionId; does not own resources. */
	readonly promptCacheKey?: string;
	/** Lets OpenAI Responses models run the provider-hosted web search; ignored by other APIs. */
	readonly webSearch?: boolean;
	/** Output budget including reasoning tokens. Defaults to 4096. */
	readonly maxOutputTokens?: number;
	readonly signal?: AbortSignal;
}

export interface ConversationResult {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly usage?: {
		readonly input: number | null;
		readonly output: number | null;
		readonly cacheRead: number | null;
		/** True only when a valid raw count or positive normalized count proves provider reporting. */
		readonly cacheReadReported?: boolean;
		readonly cacheWrite: number | null;
	} | null;
	/** Model-rate costs calculated by pi-ai, not a provider billing receipt. */
	readonly cost?: {
		readonly input: number | null;
		readonly output: number | null;
		readonly cacheRead: number | null;
		readonly cacheWrite: number | null;
		readonly total: number | null;
	} | null;
	readonly stopReason?: string | null;
	readonly responseId?: string | null;
	readonly provider?: string | null;
	readonly model?: string | null;
	/** Present only when the provider explicitly reports these response fields. */
	readonly responseModel?: string;
	readonly reasoningEffort?: string;
	/** Sources the provider-hosted web search cited in the final answer. */
	readonly citations?: readonly ConversationCitation[];
	readonly webSearchCalls?: number;
}

export interface ConversationCitation {
	readonly url: string;
	readonly title?: string;
}

export interface AgentToolApprovalRequest {
	readonly approvalId: string;
	readonly toolName: "bash" | "edit" | "write";
	readonly summary: string;
	readonly targetPath?: string;
	readonly beforeSha256?: string;
	readonly afterSha256?: string;
	readonly preview: string;
}

export interface AgentBashSpawnContext {
	readonly command: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

/** One native agent turn with read, bash, edit, write and delegate tools in projectRoot. */
export interface AgentTaskRequest {
	readonly projectRoot: string;
	readonly objective: string;
	readonly provider?: string;
	readonly model?: string;
	readonly accountId?: string;
	readonly images?: readonly CodingTaskImage[];
	/** Continue this saved agent session instead of starting a new one. */
	readonly sessionId?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal?: AbortSignal;
	readonly onEvent: (event: CodingTaskEvent) => void;
	/** Every bash, edit and write call waits for this; without it those tools fail. */
	readonly requestToolApproval?: (request: AgentToolApprovalRequest) => Promise<boolean>;
	readonly recordEffectBoundary?: (effect: CodingTaskEffectBoundary) => Promise<void>;
	/** When set, the read tool only opens files beneath these directories, for this task and its delegates. */
	readonly readableRoots?: readonly string[];
	/** Rewrites each bash command before it runs, for example to wrap it in a stricter sandbox. */
	readonly bashSpawnHook?: (context: AgentBashSpawnContext) => AgentBashSpawnContext;
}

export interface AgentTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "aborted";
	readonly usage: CodingTaskUsage;
}

export function runCodingTask(input: CodingTaskInput): Promise<CodingTaskResult>;
export function runAgentTask(request: AgentTaskRequest): Promise<AgentTaskResult>;
export function runConversation(input: ConversationInput): Promise<ConversationResult>;
export function resumeCodingTask(input: ResumeCodingTaskInput): Promise<CodingTaskResult | undefined>;
