import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listProjectFilePaths, resolveRipgrepPath, searchProjectFiles } from "../src/project-files.ts";

const temporaryDirectories: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-project-files-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "alpha.ts"), "export const TARGET = 1;\nconst other = TARGET;\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "ignored.js"), "TARGET\n");
	mkdirSync(join(root, ".hidden"));
	writeFileSync(join(root, ".hidden", "ignored.ts"), "TARGET\n");
	mkdirSync(join(root, "artifacts"));
	writeFileSync(join(root, "artifacts", "ignored.txt"), "TARGET\n");
	return root;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("project file fallback", () => {
	it("prefers the coding-agent managed ripgrep binary", () => {
		const agentRoot = fixture();
		const binDirectory = join(agentRoot, "bin");
		const managedRipgrep = join(binDirectory, process.platform === "win32" ? "rg.exe" : "rg");
		mkdirSync(binDirectory);
		writeFileSync(managedRipgrep, "");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentRoot);

		expect(resolveRipgrepPath()).toBe(managedRipgrep);
	});

	it("lists and searches bounded project files without ripgrep", () => {
		const root = fixture();

		expect(listProjectFilePaths(root, null)).toEqual(["src/alpha.ts"]);
		expect(searchProjectFiles(root, "TARGET", 5_000, null)).toEqual({
			status: "completed",
			lines: ["./src/alpha.ts:1:export const TARGET = 1;", "./src/alpha.ts:2:const other = TARGET;"],
		});
	});
});
