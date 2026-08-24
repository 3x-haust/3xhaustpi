import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	beforeRename: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		rename: async (from: string, to: string) => {
			const beforeRename = mocks.beforeRename;
			mocks.beforeRename = undefined;
			beforeRename?.(from, to);
			return original.rename(from, to);
		},
	};
});

import {
	beginApprovedFileTransaction,
	recoverApprovedFileTransactions,
} from "../src/agent-approved-file-transaction.ts";
import { approvedFileWrite } from "../src/agent-approved-tools.ts";

const directories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	mocks.beforeRename = undefined;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("approved file commit fencing", () => {
	it("does not overwrite a replacement that lands in the commit window", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "3xhaustpi-approved-race-"));
		directories.push(projectRoot);
		process.env.PI_CODING_AGENT_DIR = join(projectRoot, "agent");
		const path = join(projectRoot, "src.txt");
		const originalPath = join(projectRoot, "original.txt");
		writeFileSync(path, "before", "utf8");
		mocks.beforeRename = () => {
			renameSync(path, originalPath);
			writeFileSync(path, "raced", "utf8");
		};

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				requestApproval: async () => true,
			}),
		).rejects.toThrow(/changed after approval/u);

		expect(readFileSync(path, "utf8")).toBe("raced");
	});

	it("restores an original moved by an interrupted replacement", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "3xhaustpi-approved-recover-"));
		directories.push(projectRoot);
		process.env.PI_CODING_AGENT_DIR = join(projectRoot, "agent");
		const path = join(projectRoot, "src.txt");
		const backupPath = join(projectRoot, "src.backup");
		const stagePath = join(projectRoot, "src.stage");
		await beginApprovedFileTransaction(projectRoot, path, backupPath, stagePath, "a".repeat(64));
		writeFileSync(backupPath, "before", "utf8");
		writeFileSync(stagePath, "after", "utf8");

		await recoverApprovedFileTransactions(projectRoot);

		expect(readFileSync(path, "utf8")).toBe("before");
		expect(() => readFileSync(backupPath, "utf8")).toThrow();
	});
});
