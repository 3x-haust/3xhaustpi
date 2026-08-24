import { AgentRuntimeHost } from "./agent-runtime-host.ts";
import type { AgentTaskRequest, AgentTaskResult } from "./agent-runtime-types.ts";

export type { AgentToolApprovalRequest } from "./agent-approved-tools.ts";
export { AgentRuntimeHost } from "./agent-runtime-host.ts";
export {
	cacheRoutingOptions,
	providerCacheAffinity,
} from "./agent-runtime-provider.ts";
export {
	AgentSessionNotFoundError,
	openAgentSessionManager,
} from "./agent-runtime-session-lookup.ts";
export type {
	AgentProviderEffectBoundaryRequest,
	AgentTaskRequest,
	AgentTaskResult,
} from "./agent-runtime-types.ts";

/** Run one task with an isolated, automatically closed runtime host. */
export async function runAgentTask(request: AgentTaskRequest): Promise<AgentTaskResult> {
	const host = new AgentRuntimeHost();
	try {
		return await host.run(request);
	} finally {
		await host.close();
	}
}

export type { ModelRuntime } from "@earendil-works/pi-coding-agent";
