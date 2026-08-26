import { type Api, calculateCost, type Model, type ProviderHeaders, type Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CacheWarmResult } from "./cache-warm-controller.ts";

function requestHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function estimatedCacheSavingsUsd(model: Model<Api>, usage: Usage): number {
	if (usage.cacheRead <= 0) return 0;
	const coldUsage: Usage = {
		...usage,
		input: usage.input + usage.cacheRead + usage.cacheWrite,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const coldCost = calculateCost(model, coldUsage).total;
	return Math.max(0, coldCost - usage.cost.total);
}

export async function warmAgentPromptCache(session: AgentSession, signal: AbortSignal): Promise<CacheWarmResult> {
	const model = session.model;
	if (!model) throw new Error("Cache warming requires an active model");
	if (!session.isIdle) throw new Error("Cache warming requires an idle agent session");

	const auth = await session.modelRuntime.getAuth(model);
	if (!auth?.auth.apiKey && !auth?.auth.headers) {
		throw new Error(`Cache warming requires authentication for ${model.provider}`);
	}

	let messages = [...session.messages];
	if (session.agent.transformContext) messages = await session.agent.transformContext(messages, signal);
	const providerMessages = await session.agent.convertToLlm(messages);
	const startedAt = performance.now();
	const stream = await session.agent.streamFunction(
		model,
		{
			systemPrompt: session.systemPrompt,
			messages: [
				...providerMessages,
				{ role: "user", content: [{ type: "text", text: "." }], timestamp: Date.now() },
			],
			tools: session.agent.state.tools,
		},
		{
			apiKey: auth.auth.apiKey,
			headers: requestHeaders(auth.auth.headers),
			env: auth.env,
			maxTokens: 16,
			signal,
		},
	);
	const response = await stream.result();
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Cache warm request failed");
	}
	return {
		durationMs: performance.now() - startedAt,
		contextTokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
		usage: {
			input: response.usage.input,
			output: response.usage.output,
			cacheRead: response.usage.cacheRead,
			cacheWrite: response.usage.cacheWrite,
		},
		estimatedSavingsUsd: estimatedCacheSavingsUsd(model, response.usage),
	};
}
