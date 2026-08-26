import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDiagnosticsInvocation } from "../src/coding-runtime-diagnostics.ts";

const temporaryDirectories: string[] = [];

function packageFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-diagnostics-"));
	temporaryDirectories.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
	return root;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("diagnostics invocation", () => {
	it("runs npm directly on POSIX hosts", () => {
		expect(resolveDiagnosticsInvocation(packageFixture(), { strict: false, platform: "darwin" })).toEqual({
			command: "npm test",
			executable: "npm",
			args: ["test"],
		});
	});

	it("runs npm through the Windows command interpreter", () => {
		expect(
			resolveDiagnosticsInvocation(packageFixture(), {
				strict: false,
				platform: "win32",
				comspec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toEqual({
			command: "npm test",
			executable: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm test"],
		});
	});
});
