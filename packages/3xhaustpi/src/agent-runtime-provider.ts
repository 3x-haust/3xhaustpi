import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { renderNativeGlobalInstructions } from "./agent-runtime-system-prompt.ts";

export function providerCacheAffinity(
	projectRoot: string,
	provider: string,
	model: string,
	systemPrompt?: string,
): string {
	const promptComponent = systemPrompt
		? `\0system-prompt:${createHash("sha256").update(systemPrompt).digest("hex")}`
		: "";
	const digest = createHash("sha256")
		.update(`${projectRoot}\0${provider}\0${model}${promptComponent}`)
		.digest("hex")
		.slice(0, 32);
	return `3xhaustpi_${digest}`;
}

export function providerAccountCacheAffinity(
	projectRoot: string,
	provider: string,
	model: string,
	accountId: string | undefined,
	systemPrompt?: string,
): string {
	const accountAffinity = accountId ? `_${createHash("sha256").update(accountId).digest("hex").slice(0, 12)}` : "";
	return `${providerCacheAffinity(projectRoot, provider, model, systemPrompt)}${accountAffinity}`;
}

export function providerAuxiliaryCacheAffinity(
	kind: "side" | "btw",
	identity: string,
	projectRoot: string,
	provider: string,
	model: string,
	accountId: string | undefined,
	systemPrompt: string,
): string {
	const digest = createHash("sha256")
		.update(
			[
				"auxiliary",
				kind,
				identity,
				projectRoot,
				provider,
				model,
				accountId ?? "",
				createHash("sha256").update(systemPrompt).digest("hex"),
			].join("\0"),
		)
		.digest("hex")
		.slice(0, 32);
	return `3xhaustpi_aux_${digest}`;
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
	globalInstructions?: string,
): void {
	type StreamFunction = AgentSession["agent"]["streamFunction"];
	type RoutingState = {
		baseStream: StreamFunction;
		cacheAffinity: string;
		onProviderPayload: ((payload: unknown) => void) | undefined;
		requiredSystemPrompt: string;
		globalInstructions: string | undefined;
	};
	const agent = session.agent as AgentSession["agent"] & {
		__threeXhaustPiRoutingState?: RoutingState;
	};
	const existing = agent.__threeXhaustPiRoutingState;
	if (existing) {
		existing.cacheAffinity = cacheAffinity;
		existing.onProviderPayload = onProviderPayload;
		existing.requiredSystemPrompt = session.systemPrompt;
		existing.globalInstructions = globalInstructions;
		return;
	}
	const baseStream = session.agent.streamFunction;
	const state: RoutingState = {
		baseStream,
		cacheAffinity,
		onProviderPayload,
		requiredSystemPrompt: session.systemPrompt,
		globalInstructions,
	};
	agent.__threeXhaustPiRoutingState = state;
	session.agent.streamFunction = (requestModel, context, options) => {
		const summary = context.systemPrompt?.startsWith("You are a context summarization assistant.") ?? false;
		const systemPrompt = summary
			? state.globalInstructions &&
				!context.systemPrompt?.includes(renderNativeGlobalInstructions(state.globalInstructions))
				? `${context.systemPrompt}\n\n${renderNativeGlobalInstructions(state.globalInstructions)}`
				: context.systemPrompt
			: context.systemPrompt === state.requiredSystemPrompt ||
					context.systemPrompt?.startsWith(`${state.requiredSystemPrompt}\n`)
				? context.systemPrompt
				: [
						state.requiredSystemPrompt,
						"<session_prompt_extension>",
						context.systemPrompt ?? "",
						"</session_prompt_extension>",
					].join("\n\n");
		const enforcedContext = { ...context, systemPrompt };
		const previousOnPayload = options?.onPayload;
		return state.baseStream(requestModel, enforcedContext, {
			...options,
			...cacheRoutingOptions(state.cacheAffinity, enforcedContext.systemPrompt),
			...(requestModel.api === "openai-codex-responses" ? { transport: "websocket" as const } : {}),
			onPayload: async (payload, payloadModel) => {
				state.onProviderPayload?.(payload);
				return previousOnPayload?.(payload, payloadModel);
			},
		});
	};
}
