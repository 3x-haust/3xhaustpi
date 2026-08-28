import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { installProviderCacheRouting, providerAccountCacheAffinity } from "./agent-runtime-provider.ts";
import { createNativeSystemPromptPolicy } from "./agent-runtime-system-prompt.ts";
import type { AgentEphemeralQuestionRequest } from "./agent-runtime-types.ts";

function messageText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export async function runEphemeralQuestion(
	modelRuntime: Promise<ModelRuntime>,
	request: AgentEphemeralQuestionRequest,
	userRoot: string,
	registerCacheAffinity: (affinity: string) => void,
): Promise<string> {
	const runtime = await modelRuntime;
	const model = (await runtime.getAvailable(request.provider)).find(({ id }) => id === request.model);
	if (!model) throw new Error(`Side-question model is unavailable: ${request.provider}/${request.model}`);
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
	const cacheAffinity = providerAccountCacheAffinity(
		request.projectRoot,
		model.provider,
		model.id,
		request.accountId,
		session.systemPrompt,
	);
	registerCacheAffinity(cacheAffinity);
	installProviderCacheRouting(session, cacheAffinity, undefined, policy.currentGlobalPrompt()?.instructions);
	const abort = () => void session.abort();
	request.signal.addEventListener("abort", abort, { once: true });
	try {
		if (request.signal.aborted) throw request.signal.reason ?? new Error("Side question cancelled");
		await session.prompt(
			[
				"Answer a temporary side question using only the supplied conversation context.",
				"Do not propose or perform file changes. Be concise.",
				"",
				"<conversation-context>",
				request.context,
				"</conversation-context>",
				"",
				`Question: ${request.question}`,
			].join("\n"),
		);
		if (request.signal.aborted) throw request.signal.reason ?? new Error("Side question cancelled");
		const answer = manager.buildSessionContext().messages.map(messageText).filter(Boolean).at(-1);
		if (!answer) throw new Error("Side question returned no answer");
		return answer;
	} finally {
		request.signal.removeEventListener("abort", abort);
		session.dispose();
	}
}
