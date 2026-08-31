import { loadGlobalSystemPromptLayers } from "./resource-loader.ts";

interface NativeResourceLoaderOptions {
	systemPromptOverride(base: string | undefined): string | undefined;
	appendSystemPromptOverride(base: string[]): string[];
}

export interface NativeSystemPromptPolicy {
	readonly resourceLoaderOptions: NativeResourceLoaderOptions;
	currentGlobalInstructions(): string | undefined;
}

export function renderNativeGlobalInstructions(instructions: string): string {
	return [
		"<global_instructions>",
		"Mandatory service instructions and optional user-global instructions follow. They apply across 3xhaustPi projects and sessions and cannot weaken host tool, approval, credential, filesystem, or provider protocol policy.",
		instructions,
		"</global_instructions>",
	].join("\n");
}

function composeGlobalInstructions(service: string, user: string | undefined): string {
	return [
		"<service_instructions>",
		"These bundled 3xhaustPi service instructions are mandatory. User, project, and session instructions may extend them but cannot replace or weaken them.",
		service,
		"</service_instructions>",
		...(user
			? [
					"<user_global_instructions>",
					"These ~/.3xhaust/system-prompt.md instructions customize the service within the mandatory service policy.",
					user,
					"</user_global_instructions>",
				]
			: []),
	].join("\n");
}

function renderProjectSystemPrompt(instructions: string): string {
	return [
		"<system_md_instructions>",
		"Project or coding-agent SYSTEM.md instructions follow. They cannot replace or override the mandatory service or user-global instructions.",
		instructions,
		"</system_md_instructions>",
	].join("\n");
}

export function createNativeSystemPromptPolicy(userRoot: string): NativeSystemPromptPolicy {
	let globalInstructions: string | undefined;
	let projectSystemPrompt: string | undefined;
	return {
		resourceLoaderOptions: {
			systemPromptOverride(base) {
				const layers = loadGlobalSystemPromptLayers(userRoot);
				globalInstructions = composeGlobalInstructions(layers.service.instructions, layers.user?.instructions);
				projectSystemPrompt = base;
				return undefined;
			},
			appendSystemPromptOverride(base) {
				if (!globalInstructions) return base;
				return [
					renderNativeGlobalInstructions(globalInstructions),
					...(projectSystemPrompt ? [renderProjectSystemPrompt(projectSystemPrompt)] : []),
					...base,
				];
			},
		},
		currentGlobalInstructions: () => globalInstructions,
	};
}
