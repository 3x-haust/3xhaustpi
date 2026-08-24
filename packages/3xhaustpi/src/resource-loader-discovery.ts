import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectDataDirectory, resolveUserDataDirectory } from "./identity.ts";
import type {
	HarnessResourceOptions,
	HarnessResources,
	ResourceEntry,
	SkillResource,
} from "./resource-loader-contracts.ts";
import { parseHookManifest } from "./resource-loader-hooks.ts";
import { loadSkills, renderSkillContext } from "./resource-loader-skills.ts";

const MAX_SKILLS = 16;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function loadHarnessResources(options: HarnessResourceOptions): HarnessResources {
	const builtinRoot = options.builtinRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../resources");
	const userRoot = options.userRoot ?? resolveUserDataDirectory();
	const projectRoot = resolveProjectDataDirectory(options.projectRoot);
	const roots = [
		{ root: builtinRoot, scope: "builtin" as const },
		{ root: userRoot, scope: "user" as const },
		{ root: projectRoot, scope: "project" as const },
	];
	const byId = new Map<string, SkillResource>();
	for (const { root, scope } of roots) {
		for (const skill of loadSkills(root, scope)) byId.set(skill.id, skill);
	}
	const skills = [...byId.values()];
	if (skills.length > MAX_SKILLS) throw new Error(`At most ${MAX_SKILLS} skills may be active`);

	const userHooks = parseHookManifest(join(userRoot, "hooks.json"), "user");
	const projectHooks = parseHookManifest(join(projectRoot, "hooks.json"), "project");
	const hooks = options.allowProjectHooks ? [...userHooks, ...projectHooks] : userHooks;
	const entries: ResourceEntry[] = [
		...skills.map((skill) => ({
			kind: "skill" as const,
			id: skill.id,
			scope: skill.scope,
			state: "enabled" as const,
			sourcePath: skill.sourcePath,
		})),
		...userHooks.map((hook) => ({
			kind: "hook" as const,
			id: hook.id,
			scope: hook.scope,
			state: "enabled" as const,
			sourcePath: hook.sourcePath,
		})),
		...projectHooks.map((hook) => ({
			kind: "hook" as const,
			id: hook.id,
			scope: hook.scope,
			state: options.allowProjectHooks ? ("enabled" as const) : ("disabled" as const),
			sourcePath: hook.sourcePath,
			...(options.allowProjectHooks ? {} : { reason: "project hooks require opt-in" }),
		})),
	];
	const context = renderSkillContext(skills);
	const receipt = JSON.stringify({
		skills: skills.map(({ id, scope, sha256 }) => ({ id, scope, sha256 })),
		hooks: hooks.map(({ id, event, command, args, scope }) => ({ id, event, command, args, scope })),
	});
	return {
		skills,
		hooks,
		entries,
		skillContext: context,
		digest: `sha256:${digest(receipt)}`,
	};
}
