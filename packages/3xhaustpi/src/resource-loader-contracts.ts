import type { CodingTaskEvent } from "./coding-runtime.ts";

export type ResourceScope = "builtin" | "user" | "project";
export type HookEvent = CodingTaskEvent["type"];

export interface GlobalSystemPromptResource {
	readonly instructions: string;
	readonly sourcePath: string;
	readonly sha256: string;
}

export interface SkillResource {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly scope: ResourceScope;
	readonly sourcePath: string;
	readonly sha256: string;
}

export interface ObserverHook {
	readonly id: string;
	readonly event: HookEvent;
	readonly command: string;
	readonly args: readonly string[];
	readonly scope: "user" | "project";
	readonly sourcePath: string;
}

export interface ResourceEntry {
	readonly kind: "skill" | "hook";
	readonly id: string;
	readonly scope: ResourceScope;
	readonly state: "enabled" | "disabled";
	readonly sourcePath: string;
	readonly reason?: string;
}

export interface HarnessResourceOptions {
	readonly projectRoot: string;
	readonly userRoot?: string;
	readonly builtinRoot?: string;
	readonly allowProjectHooks?: boolean;
}

export interface HarnessResources {
	readonly globalSystemPrompt?: GlobalSystemPromptResource;
	readonly skills: readonly SkillResource[];
	readonly hooks: readonly ObserverHook[];
	readonly entries: readonly ResourceEntry[];
	readonly skillContext: string;
	readonly resourceContextDigest: string;
	readonly digest: string;
}
