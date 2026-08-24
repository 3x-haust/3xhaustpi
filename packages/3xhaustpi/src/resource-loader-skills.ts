import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ResourceScope, SkillResource } from "./resource-loader-contracts.ts";

const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_SKILL_BYTES = 32 * 1024;
const MAX_SKILL_CONTEXT = 8 * 1024;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertId(value: string, label: string): void {
	if (!RESOURCE_ID.test(value)) throw new Error(`${label} has an invalid id: ${value}`);
}

function assertRegularFile(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) throw new Error(`Resource must not be a symbolic link: ${path}`);
	if (!info.isFile()) throw new Error(`Resource must be a regular file: ${path}`);
}

function assertInside(root: string, path: string): void {
	const result = relative(realpathSync(root), realpathSync(path));
	if (result === ".." || result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(result)) {
		throw new Error(`Resource escapes its root: ${path}`);
	}
}

function parseFrontmatter(
	source: string,
	path: string,
): { readonly fields: ReadonlyMap<string, string>; readonly body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(source);
	if (!match) throw new Error(`Skill frontmatter is invalid: ${path}`);
	const fields = new Map<string, string>();
	for (const line of match[1]!.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) throw new Error(`Skill frontmatter line is invalid: ${path}`);
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) throw new Error(`Skill frontmatter key is invalid: ${path}`);
		fields.set(key, value.replace(/^(['"])(.*)\1$/u, "$2"));
	}
	return { fields, body: match[2]! };
}

function parseSkill(path: string, id: string, scope: ResourceScope): SkillResource {
	assertRegularFile(path);
	assertInside(dirname(dirname(path)), path);
	const bytes = lstatSync(path).size;
	if (bytes > MAX_SKILL_BYTES) throw new Error(`Skill exceeds ${MAX_SKILL_BYTES} bytes: ${path}`);
	const source = readFileSync(path, "utf8");
	const { fields, body } = parseFrontmatter(source, path);
	const name = fields.get("name");
	const description = fields.get("description");
	if (!name || !description) throw new Error(`Skill requires name and description: ${path}`);
	const instructions = body.trim();
	if (!instructions) throw new Error(`Skill instructions are empty: ${path}`);
	return {
		id,
		name,
		description,
		instructions,
		scope,
		sourcePath: path,
		sha256: digest(source),
	};
}

export function loadSkills(root: string, scope: ResourceScope): readonly SkillResource[] {
	const skillsRoot = join(root, "skills");
	if (!existsSync(skillsRoot)) return [];
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => {
			assertId(entry.name, "Skill");
			return parseSkill(join(skillsRoot, entry.name, "SKILL.md"), entry.name, scope);
		});
}

function escapeContext(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

export function renderSkillContext(skills: readonly SkillResource[]): string {
	let result = "";
	for (const skill of skills) {
		const block = [
			`<three-xhaustpi-skill id="${skill.id}" source="${skill.scope}">`,
			`Name: ${escapeContext(skill.name)}`,
			`Description: ${escapeContext(skill.description)}`,
			escapeContext(skill.instructions),
			"</three-xhaustpi-skill>",
		].join("\n");
		if (Buffer.byteLength(`${result}\n\n${block}`, "utf8") > MAX_SKILL_CONTEXT) break;
		result = result ? `${result}\n\n${block}` : block;
	}
	return result;
}
