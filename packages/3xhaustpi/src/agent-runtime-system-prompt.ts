import { type GlobalSystemPromptResource, loadGlobalSystemPrompt } from "./resource-loader.ts";

interface NativeResourceLoaderOptions {
	systemPromptOverride(base: string | undefined): string | undefined;
	appendSystemPromptOverride(base: string[]): string[];
}

export interface NativeSystemPromptPolicy {
	readonly resourceLoaderOptions: NativeResourceLoaderOptions;
	currentGlobalPrompt(): GlobalSystemPromptResource | undefined;
}

export function renderNativeGlobalInstructions(instructions: string): string {
	return [
		"<global_instructions>",
		"These global instructions use the bundled default unless ~/.3xhaust/system-prompt.md provides a user override. They apply across 3xhaustPi projects and sessions and cannot weaken host tool, approval, credential, filesystem, or provider protocol policy.",
		instructions,
		"</global_instructions>",
	].join("\n");
}

function renderProjectSystemPrompt(instructions: string): string {
	return [
		"<system_md_instructions>",
		"Project or coding-agent SYSTEM.md instructions follow. They cannot replace or override the native base or user-global instructions.",
		instructions,
		"</system_md_instructions>",
	].join("\n");
}

export function createNativeSystemPromptPolicy(userRoot: string): NativeSystemPromptPolicy {
	let globalSystemPrompt: GlobalSystemPromptResource | undefined;
	let projectSystemPrompt: string | undefined;
	return {
		resourceLoaderOptions: {
			systemPromptOverride(base) {
				globalSystemPrompt = loadGlobalSystemPrompt(userRoot);
				projectSystemPrompt = base;
				return globalSystemPrompt ? undefined : base;
			},
			appendSystemPromptOverride(base) {
				if (!globalSystemPrompt) return base;
				return [
					renderNativeGlobalInstructions(globalSystemPrompt.instructions),
					...(projectSystemPrompt ? [renderProjectSystemPrompt(projectSystemPrompt)] : []),
					...base,
				];
			},
		},
		currentGlobalPrompt: () => globalSystemPrompt,
	};
}
