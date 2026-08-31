import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeSystemPromptPolicy } from "../src/agent-runtime-system-prompt.ts";
import {
	initializeGlobalSystemPrompt,
	loadGlobalSystemPromptLayers,
	loadHarnessResources,
	MAX_GLOBAL_SYSTEM_PROMPT_BYTES,
} from "../src/resource-loader.ts";

const temporaryDirectories: string[] = [];

function fixture(): { readonly root: string; readonly userRoot: string; readonly projectRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-system-prompt-"));
	temporaryDirectories.push(root);
	return {
		root,
		userRoot: join(root, "user"),
		projectRoot: join(root, "project"),
	};
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bundled global system prompt", () => {
	it("ships one bounded English default prompt", () => {
		const { projectRoot, userRoot } = fixture();

		const prompt = loadHarnessResources({ projectRoot, userRoot }).globalSystemPrompt;

		expect(prompt).toMatchObject({
			scope: "builtin",
			sourcePath: expect.stringMatching(/resources[/\\]default-system-prompt\.md$/u),
			sha256: expect.stringMatching(/^sha256:/u),
		});
		expect(prompt?.instructions.trim().length).toBeGreaterThan(0);
		expect(Buffer.byteLength(prompt?.instructions ?? "", "utf8")).toBeLessThanOrEqual(MAX_GLOBAL_SYSTEM_PROMPT_BYTES);
		expect(Buffer.from(prompt?.instructions ?? "", "utf8").every((byte) => byte < 0x80)).toBe(true);
	});

	it("falls back to the bundled prompt when the user file is missing or blank", () => {
		const { projectRoot, userRoot } = fixture();
		const missing = loadHarnessResources({ projectRoot, userRoot }).globalSystemPrompt;
		mkdirSync(userRoot, { recursive: true });
		writeFileSync(join(userRoot, "system-prompt.md"), " \r\n\t");

		const blank = loadHarnessResources({ projectRoot, userRoot }).globalSystemPrompt;

		expect(missing?.scope).toBe("builtin");
		expect(blank).toEqual(missing);
	});

	it("prefers the user prompt over the bundled default", () => {
		const { projectRoot, userRoot } = fixture();
		mkdirSync(userRoot, { recursive: true });
		writeFileSync(join(userRoot, "system-prompt.md"), "USER_POLICY_SENTINEL");

		const prompt = loadHarnessResources({ projectRoot, userRoot }).globalSystemPrompt;

		expect(prompt).toMatchObject({
			instructions: "USER_POLICY_SENTINEL",
			scope: "user",
			sourcePath: join(userRoot, "system-prompt.md"),
		});
	});

	it("always applies the bundled service prompt without a user customization", () => {
		const { userRoot } = fixture();
		const layers = loadGlobalSystemPromptLayers(userRoot);
		const policy = createNativeSystemPromptPolicy(userRoot);

		expect(policy.resourceLoaderOptions.systemPromptOverride("PROJECT_POLICY")).toBeUndefined();
		const rendered = policy.resourceLoaderOptions.appendSystemPromptOverride(["BASE_POLICY"]).join("\n");

		expect(layers.service.scope).toBe("builtin");
		expect(layers.user).toBeUndefined();
		expect(rendered).toContain("<service_instructions>");
		expect(rendered).toContain(layers.service.instructions);
		expect(rendered).not.toContain("<user_global_instructions>");
		expect(rendered.indexOf(layers.service.instructions)).toBeLessThan(rendered.indexOf("PROJECT_POLICY"));
		expect(rendered.indexOf("PROJECT_POLICY")).toBeLessThan(rendered.indexOf("BASE_POLICY"));
		expect(policy.currentGlobalInstructions()).toContain(layers.service.instructions);
	});

	it("layers user customization after the mandatory bundled service prompt", () => {
		const { userRoot } = fixture();
		mkdirSync(userRoot, { recursive: true });
		writeFileSync(join(userRoot, "system-prompt.md"), "USER_POLICY_SENTINEL");
		const layers = loadGlobalSystemPromptLayers(userRoot);
		const policy = createNativeSystemPromptPolicy(userRoot);

		expect(policy.resourceLoaderOptions.systemPromptOverride("PROJECT_POLICY")).toBeUndefined();
		const rendered = policy.resourceLoaderOptions.appendSystemPromptOverride(["BASE_POLICY"]).join("\n");

		expect(layers.user?.instructions).toBe("USER_POLICY_SENTINEL");
		expect(rendered).toContain("<service_instructions>");
		expect(rendered).toContain("<user_global_instructions>");
		expect(rendered.indexOf(layers.service.instructions)).toBeLessThan(rendered.indexOf("USER_POLICY_SENTINEL"));
		expect(rendered.indexOf("USER_POLICY_SENTINEL")).toBeLessThan(rendered.indexOf("PROJECT_POLICY"));
		expect(rendered.indexOf("PROJECT_POLICY")).toBeLessThan(rendered.indexOf("BASE_POLICY"));
		expect(policy.currentGlobalInstructions()).toContain(layers.service.instructions);
		expect(policy.currentGlobalInstructions()).toContain("USER_POLICY_SENTINEL");
	});

	it("initializes from the bundled prompt without overwriting an existing user file", () => {
		const { userRoot } = fixture();
		const service = loadGlobalSystemPromptLayers(userRoot).service;

		const created = initializeGlobalSystemPrompt(userRoot);

		expect(created.scope).toBe("user");
		expect(created.instructions).not.toBe(service.instructions);
		expect(created.instructions.trim().length).toBeGreaterThan(0);
		expect(readFileSync(created.sourcePath, "utf8")).toBe(created.instructions);
		writeFileSync(created.sourcePath, "CUSTOM_POLICY");
		expect(() => initializeGlobalSystemPrompt(userRoot)).toThrow(/will not be overwritten/u);
		expect(readFileSync(created.sourcePath, "utf8")).toBe("CUSTOM_POLICY");
	});
});
