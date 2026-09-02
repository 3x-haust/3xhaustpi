import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentEventProjection } from "./agent-runtime-events.ts";
import { installProviderCacheRouting, providerAccountCacheAffinity } from "./agent-runtime-provider.ts";
import type { AgentTaskRequest, AgentTaskResult } from "./agent-runtime-types.ts";

class AgentSessionModelError extends Error {
	constructor() {
		super("Agent session has no available model");
		this.name = "AgentSessionModelError";
	}
}

class AgentTerminalResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentTerminalResponseError";
	}
}

export interface AgentTaskExecutionContext {
	readonly session: AgentSession;
	readonly registerCacheAffinity: (cacheAffinity: string) => void;
	readonly globalInstructions?: string;
}

export async function executeAgentTask(
	request: AgentTaskRequest,
	projectRoot: string,
	context: AgentTaskExecutionContext,
): Promise<AgentTaskResult> {
	const { session } = context;
	const model = session.model;
	if (!model) throw new AgentSessionModelError();
	const sessionId = session.sessionManager.getSessionId();
	const cacheAffinity = providerAccountCacheAffinity(
		projectRoot,
		model.provider,
		model.id,
		request.accountId,
		session.systemPrompt,
	);
	context.registerCacheAffinity(cacheAffinity);
	context.registerCacheAffinity(`${cacheAffinity}_compaction`);
	let unsubscribe: (() => void) | undefined;
	const onAbort = () => {
		void session.abort();
	};
	try {
		installProviderCacheRouting(session, cacheAffinity, request.onProviderPayload, context.globalInstructions);
		request.onEvent({
			type: "session.started",
			runtimeKind: "native-agent",
			sessionId,
			provider: model.provider,
			model: model.id,
			objective: request.objective,
		});
		const projection = createAgentEventProjection(sessionId, request.onEvent);
		unsubscribe = session.subscribe(projection.listener);
		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.signal?.aborted) {
			onAbort();
			throw request.signal.reason instanceof Error ? request.signal.reason : new Error("Agent task cancelled");
		}
		await request.recordEffectBoundary?.({ effectId: `provider_${sessionId}`, kind: "provider" });
		if (request.signal?.aborted) {
			throw request.signal.reason instanceof Error ? request.signal.reason : new Error("Agent task cancelled");
		}
		await session.prompt(request.objective, {
			...(request.images?.length
				? { images: request.images.map((image) => ({ type: "image" as const, ...image })) }
				: {}),
		});
		const terminal = projection.terminal();
		if (!terminal) {
			throw new AgentTerminalResponseError(
				"Provider returned no assistant output. Check the selected account and model, then retry.",
			);
		}
		if (terminal.stopReason === "error") {
			throw new AgentTerminalResponseError(terminal.errorMessage ?? "Provider failed before returning an answer.");
		}
		if (terminal.stopReason === "aborted") {
			throw new AgentTerminalResponseError(
				terminal.errorMessage ?? "Provider stopped before returning an answer. Retry the request.",
			);
		}
		if (terminal.textCharacters === 0) {
			throw new AgentTerminalResponseError(
				"Provider returned no assistant output. Check the selected account and model, then retry.",
			);
		}
		const aborted = request.signal?.aborted ?? false;
		const usage = projection.usage();
		request.onEvent({
			type: "session.completed",
			sessionId,
			outcome: aborted ? "rejected" : "completed",
			decision: aborted ? "aborted" : "completed",
			usage,
		});
		return { sessionId, outcome: aborted ? "aborted" : "completed", usage };
	} finally {
		request.signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
	}
}
