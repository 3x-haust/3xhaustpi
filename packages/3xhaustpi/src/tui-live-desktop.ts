import type { DesktopApplication } from "./desktop-runtime.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { dim, failure, muted, success, text, warning } from "./tui-text.ts";

export interface TuiDesktopController {
	startComputerCommand(argument: string): void;
}

export function createTuiDesktopController(core: TuiLiveCore, view: TuiLiveView): TuiDesktopController {
	const { state } = core;
	const resolveDesktopApplication = (selector: string): DesktopApplication | undefined => {
		const numeric = Number.parseInt(selector, 10);
		if (String(numeric) === selector && numeric >= 1) return state.desktopApplications[numeric - 1];
		const normalized = selector.toLowerCase();
		const matches = state.desktopApplications.filter(
			(application) =>
				application.name.toLowerCase() === normalized || application.bundleId.toLowerCase() === normalized,
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const refreshDesktopApplications = async (signal: AbortSignal) => {
		const result = await core.desktopHost.listApplications(signal);
		if (!result.trusted) throw new Error("macOS Accessibility permission is required for Computer Use.");
		state.desktopApplications = result.applications;
		view.appendText(text("Computer Use"));
		if (state.desktopApplications.length === 0) view.appendText(dim("No accessible GUI applications are running."));
		for (const [index, application] of state.desktopApplications.entries()) {
			view.appendText(
				`${application.active ? success("●") : dim("○")} ${index + 1}  ${text(application.name)}  ${dim(application.bundleId)}`,
			);
		}
		view.appendText(dim("Use /computer observe <number> to inspect accessibility elements."));
	};
	const runComputerCommand = async (argument: string, signal: AbortSignal) => {
		const [operation = "apps", selector = ""] = argument.split(/\s+/u).filter(Boolean);
		if (operation === "apps") {
			await refreshDesktopApplications(signal);
			return;
		}
		if (operation === "observe") {
			if (state.desktopApplications.length === 0) await refreshDesktopApplications(signal);
			const application = resolveDesktopApplication(selector);
			if (!application) throw new Error(`Desktop application not found or ambiguous: ${selector || "(empty)"}`);
			const observation = await core.desktopHost.observe({ pid: application.pid }, { signal, maxElements: 96 });
			state.desktopObservation = observation;
			view.appendText(
				`${text(observation.application.name)}  ${muted(`${observation.elements.length} elements · ${observation.durationMs.toFixed(0)} ms`)}`,
			);
			for (const [index, element] of observation.elements.slice(0, 40).entries())
				view.appendText(`${index + 1}  ${dim(element.role)}  ${text(element.name)}`);
			if (observation.elements.length > 40)
				view.appendText(dim(`${observation.elements.length - 40} more elements omitted from the transcript.`));
			view.appendText(dim("Use /computer click <element number> for a reviewed semantic action."));
			return;
		}
		if (operation !== "click")
			throw new Error("Use /computer, /computer observe <app>, or /computer click <element>.");
		if (!state.desktopObservation) throw new Error("Observe an application before selecting an element.");
		const elementIndex = Number.parseInt(selector, 10);
		const element =
			String(elementIndex) === selector && elementIndex >= 1
				? state.desktopObservation.elements[elementIndex - 1]
				: undefined;
		if (!element) throw new Error(`Accessibility element not found: ${selector || "(empty)"}`);
		if (element.role !== "button" && element.role !== "link" && element.role !== "menu-item")
			throw new Error(`${element.role} does not support a reviewed semantic click.`);
		state.phase = "awaiting-approval";
		const reviewText = `Computer approval\nclick ${element.role} “${element.name}”\napplication ${state.desktopObservation.application.name}`;
		state.approvalReviewText = reviewText;
		view.closeHistory();
		view.followTranscript();
		view.appendText(warning(reviewText));
		view.updateChrome("review Computer Use action");
		const approved = await new Promise<boolean>((resolve) => {
			state.approvalResolve = resolve;
			state.approvalKind = "computer";
		});
		if (!approved) {
			state.phase = "ready";
			view.appendText(warning("Computer action rejected"));
			return;
		}
		state.phase = "running";
		view.updateChrome("running semantic action…");
		const observation = state.desktopObservation;
		const result = await core.desktopHost.act(
			{ pid: observation.application.pid },
			{
				action: "click",
				target: { ...element, observationDigest: observation.digest },
				button: "left",
			},
			{ signal },
		);
		state.phase = "ready";
		view.appendText(`${success("✓")} Computer action completed  ${muted(`${result.durationMs.toFixed(1)} ms`)}`);
	};
	const startComputerCommand = (argument: string) => {
		if (state.desktopOperation) {
			view.appendText(warning("A Computer Use operation is already active."));
			return;
		}
		if (state.activeExecution) {
			view.appendText(warning("Finish the active coding task before using Computer Use."));
			return;
		}
		const controller = new AbortController();
		state.desktopController = controller;
		const operation = runComputerCommand(argument, controller.signal)
			.catch((cause) => {
				state.phase = "error";
				view.appendText(failure(`Computer Use: ${cause instanceof Error ? cause.message : String(cause)}`));
			})
			.finally(() => {
				state.desktopController = undefined;
				state.desktopOperation = undefined;
				if (state.phase === "error") state.phase = "ready";
				view.updateChrome("");
				if (!state.active && !state.activeExecution) core.finish();
			});
		state.desktopOperation = operation;
	};
	return { startComputerCommand };
}
