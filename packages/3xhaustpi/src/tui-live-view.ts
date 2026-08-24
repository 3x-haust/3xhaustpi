import type { AgentConversationMessage } from "./agent-session-catalog.ts";
import type { CodingTaskPatchProposal } from "./coding-runtime.ts";
import { ASSISTANT_DISPLAY_NAME } from "./product-identity.ts";
import { formatTuiActivityLine, retainTuiActivityDetail } from "./tui-activity-state.ts";
import { formatPatchApprovalTranscriptEntry } from "./tui-approval.ts";
import type { TuiViewState } from "./tui-contract.ts";
import { TuiHistoryOverlay } from "./tui-history-overlay.ts";
import {
	contextHeaderRail,
	identityRail,
	isTuiTranscriptScrollInput,
	layoutTuiFrame,
	TUI_SCROLL_KEYS,
	transcriptViewportRows,
} from "./tui-layout-frame.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import { FloorNotice, SupportedTerminalComponent } from "./tui-terminal-components.ts";
import { accent, failure, muted, success, text } from "./tui-text.ts";
import { AssistantTranscriptFlow, formatSubmittedPromptTurn, formatVisibleTranscriptEntry } from "./tui-transcript.ts";

export interface TuiLiveView {
	readonly assistantFlow: AssistantTranscriptFlow;
	readonly workAnimationTimer: ReturnType<typeof setInterval> | undefined;
	refreshWorkspace(): void;
	refreshQueue(): void;
	updateHeader(): void;
	updateChrome(detail?: string): void;
	appendText(value: string): void;
	appendUser(objective: string, inserted?: boolean): void;
	appendPatch(proposal: CodingTaskPatchProposal): void;
	replaceConversation(messages: readonly AgentConversationMessage[]): void;
	followTranscript(): void;
	activeTaskCount(): number;
	hasResumableChat(): boolean;
	currentWorkDetail(): string | undefined;
	openHistory(): void;
	closeHistory(): void;
}

export function createTuiLiveView(core: TuiLiveCore): TuiLiveView {
	const { state } = core;
	const chromeState = (): TuiViewState => ({
		projectRoot: state.projectRoot,
		provider: state.provider,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		contextTokens: state.latestContextTokens,
		contextLimit: core.input.contextLimit,
		cacheHitRatio: state.latestCacheHitRatio,
		providerConfigured: core.input.providerConfigured ?? false,
		status: state.phase,
		input: core.editor.getText(),
		messages: [],
		queuedRequests: state.queuedRequests.map(({ objective }) => objective),
		workspace: state.workspace,
	});
	core.header.render = (width) => {
		const layout = layoutTuiFrame(width, process.stdout.rows || 36);
		return core.linearOutput ? [] : [contextHeaderRail(chromeState(), layout)];
	};
	core.brand.render = (width) => {
		const layout = layoutTuiFrame(width, process.stdout.rows || 36);
		return [core.linearOutput ? "3xhaustPi" : identityRail(chromeState(), layout)];
	};
	core.divider.render = (width) => (core.linearOutput ? [] : [accent("─".repeat(Math.max(1, width)))]);
	const updateHeader = () => {
		core.ui.requestRender();
	};
	const activeTaskCount = () => (state.activeExecution ? 1 : 0) + (state.desktopOperation ? 1 : 0);
	const hasResumableChat = () =>
		state.workspace.chats.some(
			(chat) => chat.status === "running" || chat.status === "paused" || chat.status === "queued",
		);
	const updateChrome = (detail?: string) => {
		state.activityDetail = retainTuiActivityDetail(state.activityDetail, detail);
		const approvalNeedsResize =
			state.approvalResolve !== undefined &&
			((process.stdout.columns || 120) < 56 || (process.stdout.rows || 36) < 12);
		const activity = formatTuiActivityLine(
			{
				status: state.phase,
				detail: approvalNeedsResize ? "resize to at least 56x12 to review" : state.activityDetail,
				queuedCount: state.queuedRequests.length,
				activeCount: activeTaskCount(),
				resumable: hasResumableChat(),
				canceled: state.canceledActive,
				detachedNew: state.detachedNewCount,
				metrics: state.latestMetricsLine,
				...(core.workMotionEnabled && (state.phase === "running" || activeTaskCount() > 0)
					? { animationFrame: state.workAnimationFrame }
					: {}),
			},
			process.stdout.columns || 120,
		);
		core.status.setText(activity);
		updateHeader();
		core.ui.requestRender();
	};
	const refreshWorkspace = () => {
		state.workspace = core.database.inspectWorkspace(state.projectRoot);
	};
	const refreshQueue = () => {
		state.queuedRequests = core.database
			.listTuiRequests(state.projectRoot)
			.filter((request) => request.status === "queued");
		updateChrome();
	};
	const appendText = (value: string) => {
		if (state.scrollOffset.value > 0) state.detachedNewCount += 1;
		core.transcriptEntries.push(formatVisibleTranscriptEntry(value));
		core.ui.requestRender();
	};
	const appendUser = (objective: string, inserted = true) => {
		const turn = formatSubmittedPromptTurn(objective, inserted);
		if (turn) appendText(turn);
	};
	const appendPatch = (proposal: CodingTaskPatchProposal) => {
		appendText(formatPatchApprovalTranscriptEntry(proposal));
	};
	const replaceConversation = (messages: readonly AgentConversationMessage[]) => {
		core.transcriptEntries.splice(0);
		assistantFlow.reset();
		for (const message of messages) {
			appendText(message.role === "user" ? `You ${message.text}` : `${ASSISTANT_DISPLAY_NAME} ${message.text}`);
		}
		followTranscript();
		updateChrome();
	};
	const followTranscript = () => {
		state.scrollOffset.value = 0;
		state.detachedNewCount = 0;
	};
	const currentWorkDetail = () => [...state.activeWork.values()].at(-1)?.label ?? state.activeCapabilities.at(-1);
	let historyHandle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
	const closeHistory = () => {
		historyHandle?.hide();
		historyHandle = undefined;
	};
	const openHistory = () => {
		if (historyHandle) {
			closeHistory();
			return;
		}
		const overlay = new TuiHistoryOverlay(core.transcriptEntries, () => process.stdout.rows || 36, {
			close: () => {
				historyHandle?.hide();
				historyHandle = undefined;
			},
			invalidate: () => core.ui.requestRender(),
		});
		historyHandle = core.ui.showOverlay(overlay, {
			width: "100%",
			maxHeight: "100%",
			anchor: "center",
			margin: 0,
		});
	};
	const assistantFlow = new AssistantTranscriptFlow(
		(entry) => {
			appendText(entry);
			return core.transcriptEntries.length - 1;
		},
		(index, entry) => {
			const current = core.transcriptEntries[index];
			if (current === undefined || !current.startsWith(`${ASSISTANT_DISPLAY_NAME} `)) {
				appendText(entry);
				return;
			}
			core.transcriptEntries[index] = entry;
			core.ui.requestRender();
		},
	);
	const viewportHeight = () => transcriptViewportRows(process.stdout.rows || 36, 0, process.stdout.columns || 120);
	const baseEditorHandleInput = core.editor.handleInput.bind(core.editor);
	core.editor.handleInput = (data: string) => {
		if (!isTuiTranscriptScrollInput(data, core.editor.getText())) {
			baseEditorHandleInput(data);
			return;
		}
		if (data === TUI_SCROLL_KEYS.pageUp) state.scrollOffset.value += viewportHeight();
		else if (data === TUI_SCROLL_KEYS.altUp) state.scrollOffset.value += 1;
		else if (data === TUI_SCROLL_KEYS.pageDown || data === TUI_SCROLL_KEYS.altDown)
			state.scrollOffset.value = Math.max(
				0,
				state.scrollOffset.value - (data === TUI_SCROLL_KEYS.pageDown ? viewportHeight() : 1),
			);
		else if (data === TUI_SCROLL_KEYS.altEnd) followTranscript();
		updateChrome();
	};
	updateHeader();
	core.ui.addChild(new FloorNotice(state));
	core.ui.addChild(new SupportedTerminalComponent(core.transcript));
	core.ui.addChild(new SupportedTerminalComponent(core.status, true));
	core.ui.addChild(
		new SupportedTerminalComponent(core.editor, false, (_width) => {
			const rows = process.stdout.rows || 36;
			const overlayRows = Math.max(3, Math.floor(rows * 0.4));
			const showScrollInfo = overlayRows >= 4;
			core.editor.setMaxVisibleLines(Math.max(1, Math.min(6, rows - 7)));
			core.editor.setAutocompleteMaxVisible(Math.max(1, overlayRows - (showScrollInfo ? 3 : 2)));
			core.editor.setAutocompleteScrollInfoVisible(showScrollInfo);
		}),
	);
	core.ui.addChild(new SupportedTerminalComponent(core.divider));
	core.ui.addChild(new SupportedTerminalComponent(core.header));
	core.ui.addChild(new SupportedTerminalComponent(core.brand));
	updateChrome();
	const workAnimationTimer = core.workMotionEnabled
		? setInterval(() => {
				if (state.phase !== "running" && activeTaskCount() === 0) return;
				state.workAnimationFrame += 1;
				updateChrome();
			}, 120)
		: undefined;
	workAnimationTimer?.unref();
	return {
		assistantFlow,
		workAnimationTimer,
		refreshWorkspace,
		refreshQueue,
		updateHeader,
		updateChrome,
		appendText,
		appendUser,
		appendPatch,
		replaceConversation,
		followTranscript,
		activeTaskCount,
		hasResumableChat,
		currentWorkDetail,
		openHistory,
		closeHistory,
	};
}

export function appendTaskCompletion(
	view: TuiLiveView,
	successValue: boolean,
	label: string,
	durationMs: number,
	summary: string,
): void {
	view.appendText(
		`${successValue ? success("✓") : failure("×")} ${text(label)}  ${muted(`${durationMs.toFixed(1)} ms · ${summary}`)}`,
	);
}
