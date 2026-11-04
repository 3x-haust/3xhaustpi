import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionManager } from "./session-manager.ts";

type SummarizationUsage = Pick<AssistantMessage, "usage" | "provider" | "model" | "stopReason" | "responseId"> & {
	source: "compaction" | "branchSummary";
};

/** Track actual provider responses, not synthetic aborts produced during retry backoff. */
export function createSummarizationUsageTracker(
	sessionManager: SessionManager,
	source: "compaction" | "branchSummary",
): {
	onResponse(message: AssistantMessage): void;
	getSuccessfulResponses(): readonly SummarizationUsage[];
	commit(): void;
	finish(): void;
} {
	const pending: SummarizationUsage[] = [];
	let finished = false;

	return {
		onResponse(message) {
			const data: SummarizationUsage = {
				usage: structuredClone(message.usage),
				source,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				responseId: message.responseId,
			};
			if (finished || message.stopReason === "error" || message.stopReason === "aborted") {
				sessionManager.appendCustomEntry("pi.summarization_usage", data);
			} else {
				pending.push(data);
			}
		},
		getSuccessfulResponses() {
			return structuredClone(pending);
		},
		commit() {
			// Successful response usage is now stored on the summary entry.
			pending.length = 0;
		},
		finish() {
			if (finished) return;
			finished = true;
			for (const data of pending) {
				sessionManager.appendCustomEntry("pi.summarization_usage", data);
			}
			pending.length = 0;
		},
	};
}
