import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function providerCacheAffinity(projectRoot: string, provider: string, model: string): string {
	const digest = createHash("sha256").update(`${projectRoot}\0${provider}\0${model}`).digest("hex").slice(0, 32);
	return `3xhaustpi_${digest}`;
}

export function cacheRoutingOptions(
	cacheAffinity: string,
	systemPrompt: string | undefined,
): {
	readonly cacheRetention: "short" | "long";
	readonly sessionId: string;
	readonly promptCacheKey: string;
} {
	const isCompaction = systemPrompt?.startsWith("You are a context summarization assistant.") ?? false;
	const key = isCompaction ? `${cacheAffinity}_compaction` : cacheAffinity;
	return {
		cacheRetention: isCompaction ? "short" : "long",
		sessionId: key,
		promptCacheKey: key,
	};
}

export function installProviderCacheRouting(
	session: AgentSession,
	cacheAffinity: string,
	onProviderPayload: ((payload: unknown) => void) | undefined,
): void {
	const baseStream = session.agent.streamFunction;
	session.agent.streamFunction = (requestModel, context, options) => {
		const previousOnPayload = options?.onPayload;
		return baseStream(requestModel, context, {
			...options,
			...cacheRoutingOptions(cacheAffinity, context.systemPrompt),
			...(requestModel.api === "openai-codex-responses" ? { transport: "websocket" as const } : {}),
			onPayload: async (payload, payloadModel) => {
				onProviderPayload?.(payload);
				return previousOnPayload?.(payload, payloadModel);
			},
		});
	};
}
