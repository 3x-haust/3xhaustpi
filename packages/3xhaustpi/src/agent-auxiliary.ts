import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { installProviderCacheRouting, providerAuxiliaryCacheAffinity } from "./agent-runtime-provider.ts";
import { createNativeSystemPromptPolicy } from "./agent-runtime-system-prompt.ts";
import type { AgentAuxiliaryRequest } from "./agent-runtime-types.ts";

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export async function runAuxiliaryQuestion(
	modelRuntime: Promise<ModelRuntime>,
	request: AgentAuxiliaryRequest,
	userRoot: string,
	registerCacheAffinity: (affinity: string) => void,
): Promise<string> {
	const runtime = await modelRuntime;
	const model = (await runtime.getAvailable(request.provider)).find(({ id }) => id === request.model);
	if (!model) throw new Error(`Auxiliary model is unavailable: ${request.provider}/${request.model}`);
	const manager = SessionManager.inMemory(request.projectRoot);
	const policy = createNativeSystemPromptPolicy(userRoot);
	const services = await createAgentSessionServices({
		cwd: request.projectRoot,
		modelRuntime: runtime,
		resourceLoaderOptions: policy.resourceLoaderOptions,
	});
	const { session } = await createAgentSessionFromServices({
		services,
		model,
		thinkingLevel: request.thinkingLevel,
		sessionManager: manager,
		tools: [],
	});
	const cacheAffinity = providerAuxiliaryCacheAffinity(
		request.kind,
		request.identity,
		request.projectRoot,
		model.provider,
		model.id,
		request.accountId,
		session.systemPrompt,
	);
	registerCacheAffinity(cacheAffinity);
	installProviderCacheRouting(session, cacheAffinity, undefined, policy.currentGlobalInstructions());
	const abort = () => void session.abort();
	request.signal.addEventListener("abort", abort, { once: true });
	try {
		if (request.signal.aborted) throw request.signal.reason ?? new Error("Auxiliary request canceled");
		const scope =
			request.kind === "side"
				? {
						mode: "isolated-side-chat",
						history: request.history,
					}
				: {
						mode: "main-aware-btw",
						history: request.history,
						observation: request.observation,
					};
		await session.prompt(
			[
				request.kind === "side"
					? "Continue an isolated Side Chat. Use only its supplied history and question. Do not infer or claim access to the main conversation."
					: "Answer a BTW question about the supplied main-conversation observation. Keep this auxiliary conversation separate from the main conversation.",
				"Do not propose or perform file changes. Be concise.",
				"",
				JSON.stringify(scope),
				"",
				`Question: ${request.question}`,
			].join("\n"),
		);
		if (request.signal.aborted) throw request.signal.reason ?? new Error("Auxiliary request canceled");
		const final = manager
			.buildSessionContext()
			.messages.filter((message) => message.role === "assistant")
			.at(-1);
		if (final?.role === "assistant" && (final.stopReason === "error" || final.stopReason === "aborted")) {
			throw new Error(final.errorMessage ?? "Auxiliary provider stopped before returning an answer");
		}
		const answer = final ? assistantText(final) : "";
		if (!answer.trim()) throw new Error("Auxiliary provider returned no assistant output");
		return answer;
	} finally {
		request.signal.removeEventListener("abort", abort);
		session.dispose();
	}
}
