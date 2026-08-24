import type { CodingTaskEvent } from "./coding-runtime.ts";

export interface DelegatedAgentEventProjection {
	readonly onEvent: (event: CodingTaskEvent) => void;
	readonly message: () => string;
}

export function createDelegatedAgentEventProjection(
	parentWorkId: string,
	objective: string,
	onEvent: (event: CodingTaskEvent) => void,
): DelegatedAgentEventProjection {
	let childSessionId: string | undefined;
	let childStartedAt: number | undefined;
	let assistantMessage = "";
	return {
		message: () => assistantMessage,
		onEvent: (event) => {
			if (event.type === "session.started" && event.runtimeKind === "native-agent") {
				childSessionId = event.sessionId;
				childStartedAt = performance.now();
				onEvent({
					type: "work.started",
					workId: event.sessionId,
					parentWorkId,
					kind: "agent",
					label: objective,
				});
				return;
			}
			if (event.type === "assistant.message") {
				assistantMessage = event.text;
				return;
			}
			if (event.type === "work.started") {
				onEvent({
					...event,
					parentWorkId: childSessionId ?? parentWorkId,
				});
				return;
			}
			if (event.type === "work.completed") {
				onEvent(event);
				return;
			}
			if (event.type === "session.completed" && childSessionId && childStartedAt !== undefined) {
				onEvent({
					type: "work.completed",
					workId: childSessionId,
					success: event.outcome === "completed",
					durationMs: Math.max(0, performance.now() - childStartedAt),
					summary: event.decision,
				});
			}
		},
	};
}
