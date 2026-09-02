import { randomUUID } from "node:crypto";
import type { ProviderConnection } from "./connections.ts";
import { auxiliaryAnswers, auxiliaryTranscript, boundedAuxiliaryHistory } from "./tui-auxiliary-history.ts";
import { resolveTuiAuxiliaryBinding } from "./tui-auxiliary-model-binding.ts";
import { TuiAuxiliaryOverlay } from "./tui-auxiliary-overlay.ts";
import { promoteTuiAuxiliaryInView } from "./tui-auxiliary-promotion.ts";
import type { TuiAuxiliaryKind, TuiCompletedAuxiliaryAnswer } from "./tui-auxiliary-types.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import { TUI_REQUEST_LEASE_MS, TUI_REQUEST_LEASE_RENEWAL_MS } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { captureTuiMainObservation } from "./tui-main-observation.ts";
import type { TuiSideTurn } from "./tui-side-chat-types.ts";
import { warning } from "./tui-text.ts";

export interface TuiAuxiliaryController {
	startSide(message: string): Promise<void>;
	startBtw(question: string): Promise<void>;
	isRunning(): boolean;
	shutdown(): Promise<void>;
}

export interface TuiAuxiliaryControllerOptions {
	readonly collectConnections?: () => Promise<readonly ProviderConnection[]>;
	readonly drainQueue?: () => void;
}

interface BtwThread {
	readonly id: string;
	readonly projectRoot: string;
	readonly turns: TuiCompletedAuxiliaryAnswer[];
}

export function createTuiAuxiliaryController(
	core: TuiLiveCore,
	view: TuiLiveView,
	options: TuiAuxiliaryControllerOptions = {},
): TuiAuxiliaryController {
	let overlay: TuiAuxiliaryOverlay | undefined;
	let overlayHandle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
	let openKind: TuiAuxiliaryKind | undefined;
	let activeController: AbortController | undefined;
	let activeExecution: Promise<void> | undefined;
	let pending: { readonly kind: TuiAuxiliaryKind; readonly message: string } | undefined;
	let btw: BtwThread | undefined;
	let shuttingDown = false;

	const currentBtw = () => (btw?.projectRoot === core.state.projectRoot ? btw : undefined);
	const answers = (kind: TuiAuxiliaryKind) => auxiliaryAnswers(core, kind, currentBtw()?.turns ?? []);
	const closeOverlay = () => {
		overlayHandle?.hide();
		overlayHandle = undefined;
		overlay = undefined;
		openKind = undefined;
	};
	const open = (kind: TuiAuxiliaryKind) => {
		closeOverlay();
		openKind = kind;
		overlay = new TuiAuxiliaryOverlay(core.ui, kind, () => process.stdout.rows || 36, {
			submit: (message) => void submit(kind, message),
			promote: () => {
				if (overlay) void promoteTuiAuxiliaryInView(core, view, overlay, answers(kind), options.drainQueue);
			},
			cancel: () => {
				activeController?.abort(new Error("Auxiliary request canceled"));
				if (pending) {
					pending = undefined;
					view.appendText(warning("Canceled pending auxiliary reply."));
				}
			},
			close: closeOverlay,
			invalidate: () => core.ui.requestRender(),
		});
		const completed = answers(kind);
		overlay.setTranscript(auxiliaryTranscript(completed));
		overlayHandle = core.ui.showOverlay(overlay, {
			width:
				(process.stdout.columns || 120) < 56
					? "100%"
					: Math.max(36, Math.min(76, (process.stdout.columns || 120) - 4)),
			maxHeight: (process.stdout.rows || 36) < 12 ? "100%" : "70%",
			anchor: "top-center",
			margin: (process.stdout.columns || 120) < 56 || (process.stdout.rows || 36) < 12 ? 0 : 2,
		});
	};
	const execute = async (kind: TuiAuxiliaryKind, message: string) => {
		const run = core.input.runAuxiliary;
		if (!run) throw new Error("Auxiliary chat is unavailable.");
		const controller = new AbortController();
		activeController = controller;
		const sourceId = `${kind}_${randomUUID()}`;
		const identity =
			kind === "side"
				? core.database.sideChats.getOrCreate(core.state.projectRoot).chatId
				: (currentBtw()?.id ?? sourceId);
		if (kind === "btw" && !currentBtw()) {
			btw = { id: identity, projectRoot: core.state.projectRoot, turns: [] };
		}
		let sideTurn: TuiSideTurn | undefined;
		let renew: ReturnType<typeof setInterval> | undefined;
		let settled = false;
		try {
			const selected = await resolveTuiAuxiliaryBinding(core, identity, options.collectConnections);
			sideTurn =
				kind === "side"
					? core.database.sideChats.begin({
							projectPath: core.state.projectRoot,
							turnId: sourceId,
							question: message,
							binding: selected,
							ownerId: core.hostOwnerId,
							leaseMs: TUI_REQUEST_LEASE_MS,
						})
					: undefined;
			overlay?.setTranscript([...auxiliaryTranscript(answers(kind)), { role: "user", text: message }]);
			overlay?.setState("running");
			const leasedTurn = sideTurn;
			renew = leasedTurn
				? setInterval(() => {
						try {
							core.database.sideChats.renew(leasedTurn.turnId, {
								ownerId: core.hostOwnerId,
								leaseEpoch: leasedTurn.leaseEpoch,
								leaseMs: TUI_REQUEST_LEASE_MS,
							});
						} catch (error) {
							controller.abort(error);
						}
					}, TUI_REQUEST_LEASE_RENEWAL_MS)
				: undefined;
			renew?.unref();
			const answer = await run({
				kind,
				identity,
				projectRoot: core.state.projectRoot,
				question: message,
				history: boundedAuxiliaryHistory(answers(kind)),
				...(kind === "btw" ? { observation: captureTuiMainObservation(core) } : {}),
				...selected,
				signal: controller.signal,
			});
			const completedAt = new Date().toISOString();
			if (sideTurn) {
				core.database.sideChats.complete(sideTurn.turnId, {
					ownerId: core.hostOwnerId,
					leaseEpoch: sideTurn.leaseEpoch,
					answer,
				});
			}
			const completed = { kind, sourceId, question: message, answer, completedAt };
			if (kind === "btw") currentBtw()?.turns.push(completed);
			settled = true;
			overlay?.setTranscript(auxiliaryTranscript(answers(kind)));
			overlay?.setState("ready");
		} catch (error) {
			const reason = controller.signal.reason;
			const canceled =
				controller.signal.aborted &&
				reason instanceof Error &&
				(reason.message === "Auxiliary request canceled" || reason.message === "3xhaustPi is exiting");
			let failureCause = error;
			if (sideTurn && !settled) {
				try {
					core.database.sideChats.terminate(sideTurn.turnId, {
						ownerId: core.hostOwnerId,
						leaseEpoch: sideTurn.leaseEpoch,
						status: canceled ? "canceled" : "failed",
						outcome: canceled ? "user-canceled" : "provider-error",
					});
				} catch (terminationError) {
					failureCause = terminationError;
				}
			}
			if (!canceled)
				overlay?.setState("failure", failureCause instanceof Error ? failureCause.message : String(failureCause));
		} finally {
			if (renew) clearInterval(renew);
			if (activeController === controller) activeController = undefined;
		}
	};
	const submit = async (kind: TuiAuxiliaryKind, message: string) => {
		if (shuttingDown) return;
		if (activeExecution) {
			if (pending) overlay?.setState("failure", "One auxiliary reply is already pending.");
			else pending = { kind, message };
			return;
		}
		const execution = execute(kind, message);
		activeExecution = execution;
		try {
			await execution;
		} finally {
			if (activeExecution === execution) activeExecution = undefined;
		}
		const next = pending;
		if (!shuttingDown && next && openKind === next.kind) {
			pending = undefined;
			await submit(next.kind, next.message);
		}
	};
	const start = async (kind: TuiAuxiliaryKind, message: string) => {
		if (shuttingDown) return;
		if (kind === "btw" && !message && !currentBtw()) {
			view.appendText(warning("Usage: /btw <question>"));
			return;
		}
		open(kind);
		if (message) await submit(kind, message);
		else if (pending?.kind === kind && !activeExecution) {
			const next = pending;
			pending = undefined;
			await submit(next.kind, next.message);
		}
	};
	return {
		startSide: (message) => start("side", message),
		startBtw: (question) => start("btw", question),
		isRunning: () => activeExecution !== undefined,
		shutdown: async () => {
			shuttingDown = true;
			pending = undefined;
			activeController?.abort(new Error("3xhaustPi is exiting"));
			const running = activeExecution;
			await running;
			if (activeExecution === running) activeExecution = undefined;
			closeOverlay();
		},
	};
}
