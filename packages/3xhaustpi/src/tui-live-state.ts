import { randomUUID } from "node:crypto";
import { Editor, ProcessTerminal, Text, TUI } from "@earendil-works/pi-tui";
import type { AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { AgentConversationSummary } from "./agent-session-catalog.ts";
import type { DesktopAccessibilityObservation, DesktopApplication } from "./desktop-runtime.ts";
import { DesktopAccessibilityHost } from "./desktop-runtime.ts";
import { type ClaimedTuiRequest, ThreeXhaustState, type TuiRequest, type WorkspaceSnapshot } from "./state.ts";
import type { RunTuiInput, TuiViewState } from "./tui-contract.ts";
import { TranscriptViewport } from "./tui-layout-frame.ts";
import { accent, dim, muted } from "./tui-text.ts";

export const TUI_REQUEST_LEASE_MS = 60_000;
export const TUI_REQUEST_LEASE_RENEWAL_MS = 20_000;

export interface TuiLiveMutableState {
	projectRoot: string;
	provider: string;
	model: string;
	thinkingLevel: NonNullable<TuiViewState["thinkingLevel"]>;
	workspace: WorkspaceSnapshot;
	conversationSessions: readonly AgentConversationSummary[];
	queuedRequests: readonly TuiRequest[];
	phase: TuiViewState["status"];
	approvalResolve: ((approved: boolean) => void) | undefined;
	approvalKind: "patch" | "computer" | "tool" | undefined;
	approvalToolName: AgentToolApprovalRequest["toolName"] | undefined;
	approvalReviewText: string | undefined;
	activeController: AbortController | undefined;
	activeExecution: Promise<void> | undefined;
	desktopController: AbortController | undefined;
	desktopOperation: Promise<void> | undefined;
	desktopApplications: readonly DesktopApplication[];
	desktopObservation: DesktopAccessibilityObservation | undefined;
	activeOperation: ClaimedTuiRequest | undefined;
	active: boolean;
	canceledActive: boolean;
	runtimePoisoned: boolean;
	latestContextTokens: number | undefined;
	latestCacheHitRatio: number | undefined;
	latestMetricsLine: string | undefined;
	responseOutputTokens: number;
	responseDurationMs: number;
	metricsScope: string | undefined;
	workAnimationFrame: number;
	activityDetail: string;
	activeCapabilities: readonly string[];
	readonly activeWork: Map<string, { readonly kind: "tool" | "agent"; readonly label: string }>;
	readonly agentSessionIds: Map<string, string>;
	terminalBelowFloor: boolean;
	readonly scrollOffset: { value: number };
	detachedNewCount: number;
}

export interface TuiLiveCore {
	readonly input: RunTuiInput;
	readonly hostOwnerId: string;
	readonly database: ThreeXhaustState;
	readonly desktopHost: NonNullable<RunTuiInput["desktopHost"]>;
	readonly ui: TUI;
	readonly editor: Editor;
	readonly transcriptEntries: string[];
	readonly transcript: TranscriptViewport;
	readonly status: Text;
	readonly header: Text;
	readonly brand: Text;
	readonly divider: Text;
	readonly state: TuiLiveMutableState;
	readonly workMotionEnabled: boolean;
	readonly linearOutput: boolean;
	readonly closed: Promise<void>;
	readonly finish: () => void;
}

function editorTheme() {
	return {
		borderColor: (value: string) => dim(value),
		selectList: {
			selectedPrefix: accent,
			selectedText: (value: string) => `\u001b[7m${value}\u001b[0m`,
			description: muted,
			scrollInfo: muted,
			noMatch: muted,
		},
	};
}

export function createTuiLiveCore(input: RunTuiInput): TuiLiveCore {
	const projectRoot = input.projectRoot;
	const database = new ThreeXhaustState(input.statePath);
	database.recoverInterruptedTuiRequests(projectRoot);
	const workspace = database.inspectWorkspace(projectRoot);
	const agentSessionId = database.findTuiAgentSession(projectRoot);
	const ui = new TUI(new ProcessTerminal());
	const editor = new Editor(ui, editorTheme(), {
		paddingX: 1,
		autocompletePresentation: "overlay",
		promptPrefix: `${accent(">")} `,
		bottomBorder: false,
		maxVisibleLines: 6,
		submitSlashArgumentCompletions: true,
	});
	const transcriptEntries: string[] = [];
	const scrollOffset = { value: 0 };
	const transcript = new TranscriptViewport(
		transcriptEntries,
		() => process.stdout.rows || 36,
		() => Math.max(0, editor.render(process.stdout.columns || 120).length - 2),
		() => scrollOffset.value,
	);
	let finish!: () => void;
	const closed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return {
		input,
		hostOwnerId: `tui_host_${randomUUID()}`,
		database,
		desktopHost: input.desktopHost ?? new DesktopAccessibilityHost(),
		ui,
		editor,
		transcriptEntries,
		transcript,
		status: new Text("", 0, 0),
		header: new Text("", 0, 0),
		brand: new Text("", 0, 0),
		divider: new Text("", 0, 0),
		workMotionEnabled:
			process.env.NO_COLOR === undefined &&
			process.env.TERM !== "dumb" &&
			process.env.REDUCE_MOTION !== "1" &&
			process.env.X3HAUSTPI_LINEAR_OUTPUT !== "1",
		linearOutput: process.env.X3HAUSTPI_LINEAR_OUTPUT === "1",
		closed,
		finish,
		state: {
			projectRoot,
			provider: input.provider ?? "openai-codex",
			model: input.model ?? "gpt-5.6-terra",
			thinkingLevel: input.thinkingLevel ?? "medium",
			workspace,
			conversationSessions: [],
			queuedRequests: database.listTuiRequests(projectRoot).filter((request) => request.status === "queued"),
			phase: "ready",
			approvalResolve: undefined,
			approvalKind: undefined,
			approvalToolName: undefined,
			approvalReviewText: undefined,
			activeController: undefined,
			activeExecution: undefined,
			desktopController: undefined,
			desktopOperation: undefined,
			desktopApplications: [],
			desktopObservation: undefined,
			activeOperation: undefined,
			active: true,
			canceledActive: false,
			runtimePoisoned: false,
			latestContextTokens: undefined,
			latestCacheHitRatio: undefined,
			latestMetricsLine: undefined,
			responseOutputTokens: 0,
			responseDurationMs: 0,
			metricsScope: undefined,
			workAnimationFrame: 0,
			activityDetail: "",
			activeCapabilities: [],
			activeWork: new Map(),
			agentSessionIds: new Map(agentSessionId ? [[projectRoot, agentSessionId]] : []),
			terminalBelowFloor: false,
			scrollOffset,
			detachedNewCount: 0,
		},
	};
}
