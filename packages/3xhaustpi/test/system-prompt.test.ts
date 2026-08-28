import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	initializeGlobalSystemPrompt,
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

	it("initializes from the bundled prompt without overwriting an existing user file", () => {
		const { userRoot } = fixture();

		const created = initializeGlobalSystemPrompt(userRoot);

		expect(created.scope).toBe("user");
		expect(readFileSync(created.sourcePath, "utf8")).toBe(created.instructions);
		writeFileSync(created.sourcePath, "CUSTOM_POLICY");
		expect(() => initializeGlobalSystemPrompt(userRoot)).toThrow(/will not be overwritten/u);
		expect(readFileSync(created.sourcePath, "utf8")).toBe("CUSTOM_POLICY");
	});
});
