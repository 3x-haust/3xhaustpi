import type { AgentProviderEffectBoundaryRequest, AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { CodingTaskEvent, CodingTaskPatchProposal } from "./coding-runtime.ts";
import type {
	DesktopAccessibilityObservation,
	DesktopActionResult,
	DesktopApplication,
	DesktopComputerAction,
} from "./desktop-runtime.ts";
import type { WorkspaceSnapshot } from "./state.ts";

export interface TuiViewState {
	readonly projectRoot: string;
	readonly model: string;
	readonly provider: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly contextTokens?: number;
	readonly contextLimit?: number;
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

export interface RunTuiInput {
	readonly projectRoot: string;
	readonly statePath?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: TuiViewState["thinkingLevel"];
	readonly contextLimit?: number;
	readonly providerConfigured?: boolean;
	readonly desktopHost?: TuiDesktopHost;
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
