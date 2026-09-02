import type { TuiAuxiliaryOverlay } from "./tui-auxiliary-overlay.ts";
import type { TuiCompletedAuxiliaryAnswer } from "./tui-auxiliary-types.ts";
import { admitReviewedTuiPromotion } from "./tui-live-main-queue.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { success, warning } from "./tui-text.ts";

export async function promoteTuiAuxiliaryInView(
	core: TuiLiveCore,
	view: TuiLiveView,
	overlay: TuiAuxiliaryOverlay,
	sources: readonly TuiCompletedAuxiliaryAnswer[],
	drainQueue: (() => void) | undefined,
): Promise<"promoted" | "duplicate" | "unavailable"> {
	overlay.setState("promoting");
	let admission: Awaited<ReturnType<typeof admitReviewedTuiPromotion>>;
	try {
		admission = await admitReviewedTuiPromotion(core, overlay, sources);
	} catch (error) {
		overlay.setState("failure", error instanceof Error ? error.message : String(error));
		return "unavailable";
	}
	if (admission.status === "review-unavailable") {
		overlay.setState("failure", "Review the complete answer before promoting it.");
		return "unavailable";
	}
	if (admission.status === "account-unavailable") {
		overlay.setState("failure", `No selected account for ${core.state.provider}.`);
		return "unavailable";
	}
	const sourceId = admission.request.promotion?.source.sourceId;
	if (!sourceId) {
		overlay.setState("failure", "Promotion metadata is unavailable.");
		return "unavailable";
	}
	overlay.markPromoted(sourceId);
	if (admission.inserted) {
		view.appendUser(admission.request.objective, true, []);
		view.appendText(success(`Promoted to main queue at position ${admission.request.position}.`));
		drainQueue?.();
	} else {
		view.appendText(warning("That auxiliary answer is already in the main queue."));
	}
	return admission.inserted ? "promoted" : "duplicate";
}
