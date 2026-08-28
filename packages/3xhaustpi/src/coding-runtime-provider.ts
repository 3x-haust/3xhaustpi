import { createHash } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { SemanticTurnResult } from "../../pi-adapter/src/index.ts";
import { type PiComplete, X3HAUST_SEMANTIC_STABLE_PREFIX } from "../../pi-adapter/src/index.ts";
import type {
	CodingTaskEvent,
	CodingTaskUsage,
	ConversationInput,
	ConversationResult,
} from "./coding-runtime-contracts.ts";
import {
	createProviderRuntime,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	providerCredentialOverride,
	resolveModel,
} from "./provider-runtime.ts";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Streams provider tokens through `assistant.delta` events while preserving the
 * non-streaming completion contract: the returned promise resolves to the final
 * assistant message, or rejects when the stream reports an error.
 */
export function createStreamingComplete(models: Models, emit: (event: CodingTaskEvent) => void): PiComplete {
	return async (requestModel, context, options) => {
		const stream = models.streamSimple(requestModel, context, options);
		let failure: unknown;
		for await (const event of stream) {
			if (event.type === "text_delta") emit({ type: "assistant.delta", text: event.delta });
			else if (event.type === "error") failure = event.error;
		}
		const message = await stream.result();
		if (failure !== undefined) throw failure;
		return message;
	};
}

export async function runConversation(input: ConversationInput): Promise<ConversationResult> {
	const provider = input.provider ?? DEFAULT_PROVIDER;
	const modelId = input.model ?? DEFAULT_MODEL;
	const models = createProviderRuntime(
		input.credential ? providerCredentialOverride(provider, input.credential) : undefined,
	);
	if (!(await models.checkAuth(provider))) throw new Error(`Provider is not authenticated: ${provider}`);
	const model = resolveModel(models, provider, modelId);
	try {
		const message = await models.completeSimple(
			model,
			{
				systemPrompt: input.system,
				messages: [
					{
						role: "user",
						content: input.images?.length
							? [
									{ type: "text", text: input.prompt },
									...input.images.map((image) => ({ type: "image" as const, ...image })),
								]
							: input.prompt,
						timestamp: Date.now(),
					},
				],
			},
			{
				...(input.signal ? { signal: input.signal } : {}),
				...(input.sessionId ? { sessionId: input.sessionId, promptCacheKey: input.sessionId } : {}),
				...(model.api === "openai-codex-responses" ? { transport: "websocket" as const } : {}),
				cacheRetention: "long",
				maxRetries: 0,
				maxTokens: 4_096,
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Provider stopped with ${message.stopReason}`);
		}
		if (message.content.some((content) => content.type === "toolCall")) {
			throw new Error("Conversation provider returned an undeclared tool call");
		}
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("")
			.trim();
		if (!text) throw new Error("Conversation provider returned no text");
		return { text, inputTokens: message.usage.input, outputTokens: message.usage.output };
	} finally {
		if (input.sessionId) cleanupSessionResources(input.sessionId);
	}
}

export function semanticUsage(result: Pick<SemanticTurnResult, "usage">): CodingTaskUsage {
	const measured = (field: "input" | "output" | "cacheRead" | "cacheWrite"): number | null => {
		const value = result.usage[field];
		return value.status === "measured" ? value.value : null;
	};
	return {
		input: measured("input"),
		output: measured("output"),
		cacheRead: measured("cacheRead"),
		cacheWrite: measured("cacheWrite"),
	};
}

const PROVIDER_TURN_TIMEOUT_MS = 60_000;

export async function runProviderTurn<T>(
	parent: AbortSignal | undefined,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (parent?.aborted) {
		const reason = parent.reason;
		throw reason instanceof Error ? reason : new Error(String(reason ?? "Provider turn cancelled"));
	}
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(parent?.reason ?? new Error("Provider turn cancelled"));
	parent?.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error(`Provider turn timed out after ${PROVIDER_TURN_TIMEOUT_MS} ms`)),
		PROVIDER_TURN_TIMEOUT_MS,
	);
	const aborted = new Promise<never>((_resolve, reject) => {
		const rejectAbort = () => {
			const reason = controller.signal.reason;
			reject(reason instanceof Error ? reason : new Error(String(reason ?? "Provider turn cancelled")));
		};
		if (controller.signal.aborted) rejectAbort();
		else controller.signal.addEventListener("abort", rejectAbort, { once: true });
	});
	try {
		return await Promise.race([operation(controller.signal), aborted]);
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", abortFromParent);
	}
}

export function configuredPythonConcurrency(environment: NodeJS.ProcessEnv = process.env): 1 | 4 | 8 | undefined {
	if (!environment.X3HAUSTPI_PYTHON) return undefined;
	const value = Number(environment.X3HAUSTPI_PYTHON_CONCURRENCY ?? "1");
	if (value !== 1 && value !== 4 && value !== 8) {
		throw new Error("X3HAUSTPI_PYTHON_CONCURRENCY must be 1, 4, or 8");
	}
	return value;
}

export function providerCacheSessionId(
	projectRoot: string,
	provider: string,
	model: string,
	objective = "",
	resourceContextDigest?: string,
): string {
	const resourcePrefix = resourceContextDigest ? `\0resource-context:${resourceContextDigest}` : "";
	return `3xhaustpi-semantic-${digest(`${X3HAUST_SEMANTIC_STABLE_PREFIX}${resourcePrefix}\0${projectRoot}\0${provider}\0${model}\0${objective}`).slice(0, 24)}`;
}

export function semanticOperationTurnIds(
	projectRoot: string,
	objective: string,
	projectRevision: string,
): { readonly initial: `turn_${string}`; readonly followup: `turn_${string}` } {
	const operation = digest(`${projectRoot}\0${objective}\0${projectRevision}`);
	return {
		initial: `turn_${operation.slice(0, 32)}` as const,
		followup: `turn_${digest(`${operation}\0followup`).slice(0, 32)}` as const,
	};
}
