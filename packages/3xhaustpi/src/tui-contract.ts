import type { AgentProviderEffectBoundaryRequest, AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { CacheWarmResult, CacheWarmTarget } from "./cache-warm-controller.ts";
import type { CodingTaskEvent, CodingTaskPatchProposal } from "./coding-runtime.ts";
import type {
	DesktopAccessibilityObservation,
	DesktopActionResult,
	DesktopApplication,
	DesktopComputerAction,
} from "./desktop-runtime.ts";
import type { WorkspaceSnapshot } from "./state.ts";
import type { TuiRequestImage } from "./tui-operation-types.ts";

export interface TuiViewState {
	readonly projectRoot: string;
	readonly model: string;
	readonly provider: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly contextTokens?: number;
	readonly contextLimit?: number;
	readonly goal?: string;
	readonly cacheHitRatio?: number;
	readonly gitStatus?: "clean" | "dirty" | "unavailable";
	readonly activeTasks?: number;
	readonly providerConfigured: boolean;
	readonly status: "ready" | "running" | "awaiting-approval" | "success" | "error";
	readonly input: string;
	readonly messages: readonly string[];
	readonly queuedRequests: readonly string[];
	readonly workspace: WorkspaceSnapshot;
}

export type TuiDensityMode = "degraded" | "minimal" | "compact" | "full" | "wide";

export interface TuiLayoutContract {
	readonly columns: number;
	readonly rows: number;
	readonly mode: TuiDensityMode;
	readonly identityRows: 2;
	readonly contextRows: 0;
	readonly activityRows: 1;
	readonly composerRows: 3;
	readonly footerRows: 0;
	readonly autocompleteRows: number;
	readonly chromeRows: number;
	readonly transcriptRows: number;
	readonly totalRows: number;
}

export interface TuiDesktopHost {
	listApplications(signal?: AbortSignal): Promise<{
		readonly trusted: boolean;
		readonly applications: readonly DesktopApplication[];
	}>;
	observe(
		target: { readonly pid: number },
		options?: { readonly signal?: AbortSignal; readonly maxElements?: number },
	): Promise<DesktopAccessibilityObservation>;
	act(
		target: { readonly pid: number },
		action: DesktopComputerAction,
		options?: { readonly signal?: AbortSignal },
	): Promise<DesktopActionResult>;
}

export interface TuiSigintTarget {
	on(event: "SIGINT", listener: () => void): unknown;
	removeListener(event: "SIGINT", listener: () => void): unknown;
}

export interface TuiSideQuestionRequest {
	readonly projectRoot: string;
	readonly question: string;
	readonly context: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: NonNullable<TuiViewState["thinkingLevel"]>;
	readonly signal: AbortSignal;
}

export interface TuiCompactConversationRequest {
	readonly projectRoot: string;
	readonly sessionId: string;
	readonly instructions?: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: NonNullable<TuiViewState["thinkingLevel"]>;
	readonly signal: AbortSignal;
}

export interface TuiCompactionResult {
	readonly tokensBefore: number;
	readonly estimatedTokensAfter?: number;
}

export interface TuiWorkingTreeReviewRequest {
	readonly projectRoot: string;
	readonly focus?: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: NonNullable<TuiViewState["thinkingLevel"]>;
	readonly signal: AbortSignal;
}

export type TuiCacheWarmRequest = CacheWarmTarget & { readonly signal: AbortSignal };

export interface RunTuiInput {
	readonly projectRoot: string;
	readonly statePath?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: TuiViewState["thinkingLevel"];
	readonly contextLimit?: number;
	readonly providerConfigured?: boolean;
	readonly desktopHost?: TuiDesktopHost;
	readonly runSideQuestion?: (request: TuiSideQuestionRequest) => Promise<string>;
	readonly compactConversation?: (request: TuiCompactConversationRequest) => Promise<TuiCompactionResult>;
	readonly warmCache?: (request: TuiCacheWarmRequest) => Promise<CacheWarmResult>;
	readonly reviewWorkingTree?: (request: TuiWorkingTreeReviewRequest) => Promise<string>;
	readonly runTask: (
		projectRoot: string,
		objective: string,
		hooks: {
			readonly onEvent: (event: CodingTaskEvent) => void;
			readonly requestApproval: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
			readonly recordEffect: (effect: AgentProviderEffectBoundaryRequest) => Promise<void>;
			readonly requestToolApproval: (request: AgentToolApprovalRequest) => Promise<boolean>;
			readonly signal: AbortSignal;
		},
		selectedModel: {
			readonly provider: string;
			readonly model: string;
			readonly accountId?: string;
			readonly images?: readonly TuiRequestImage[];
			readonly sessionId?: string;
			readonly thinkingLevel?: TuiViewState["thinkingLevel"];
		},
	) => Promise<unknown>;
	readonly resumeTask: (
		projectRoot: string,
		sessionId: string | undefined,
		hooks: {
			readonly onEvent: (event: CodingTaskEvent) => void;
			readonly requestApproval: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
			readonly recordEffect: (effect: AgentProviderEffectBoundaryRequest) => Promise<void>;
			readonly requestToolApproval: (request: AgentToolApprovalRequest) => Promise<boolean>;
			readonly signal: AbortSignal;
		},
	) => Promise<unknown | undefined>;
}
