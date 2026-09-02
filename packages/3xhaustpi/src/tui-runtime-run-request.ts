import type { TuiViewState } from "./tui-contract.ts";
import type { TuiRequestImage } from "./tui-operation-types.ts";
import type { TuiRuntimeRequest } from "./tui-runtime-protocol.ts";

export function createTuiRunRequest(input: {
	readonly projectRoot: string;
	readonly objective: string;
	readonly selectedModel: {
		readonly provider: string;
		readonly model: string;
		readonly accountId?: string;
		readonly images?: readonly TuiRequestImage[];
		readonly thinkingLevel?: TuiViewState["thinkingLevel"];
	};
	readonly sessionId?: string;
	readonly allowProjectHooks?: boolean;
}): TuiRuntimeRequest {
	return {
		mode: "run",
		projectRoot: input.projectRoot,
		objective: input.objective,
		provider: input.selectedModel.provider,
		model: input.selectedModel.model,
		...(input.selectedModel.accountId ? { accountId: input.selectedModel.accountId } : {}),
		...(input.selectedModel.images?.length ? { images: input.selectedModel.images } : {}),
		...(input.selectedModel.thinkingLevel ? { thinkingLevel: input.selectedModel.thinkingLevel } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.allowProjectHooks ? { allowProjectHooks: true } : {}),
	};
}
