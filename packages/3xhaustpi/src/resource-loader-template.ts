import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProjectDataDirectory, resolveUserDataDirectory } from "./identity.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";

const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function assertId(value: string, label: string): void {
	if (!RESOURCE_ID.test(value)) throw new Error(`${label} has an invalid id: ${value}`);
}

export function createSkillTemplate(input: {
	readonly projectRoot: string;
	readonly name: string;
	readonly scope: "project" | "user";
	readonly userRoot?: string;
}): { readonly path: string; readonly content: string } {
	assertId(input.name, "Skill");
	const root =
		input.scope === "project"
			? resolveProjectDataDirectory(input.projectRoot)
			: (input.userRoot ?? resolveUserDataDirectory());
	const path = join(root, "skills", input.name, "SKILL.md");
	if (existsSync(path)) throw new Error(`Skill already exists: ${input.name}`);
	const content = `---
name: ${input.name}
description: Describe when ${PRODUCT_DISPLAY_NAME} should load this skill.
---

# ${input.name}

Write concise, executable guidance for this workflow.
`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return { path, content };
}
