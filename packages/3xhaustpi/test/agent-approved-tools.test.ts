import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentToolApprovalRequest,
	approvedBashExecution,
	approvedFileWrite,
	createApprovedAgentTools,
} from "../src/agent-approved-tools.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectFixture() {
	const projectRoot = mkdtempSync(join(tmpdir(), "3xhaustpi-approved-tools-"));
	directories.push(projectRoot);
	return projectRoot;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("host-owned native mutation tools", () => {
	it("owns every mutating builtin definition", () => {
		const tools = createApprovedAgentTools({
			projectRoot: projectFixture(),
			requestApproval: async () => false,
		});
		expect(tools.map(({ name }) => name)).toEqual(["bash", "edit", "write"]);
		expect(tools.every(({ executionMode }) => executionMode === "sequential")).toBe(true);
	});

	it("binds write approval to path and before/after digests", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");
		writeFileSync(path, "before", "utf8");
		let request: AgentToolApprovalRequest | undefined;
		const requestApproval = vi.fn(async (value: AgentToolApprovalRequest) => {
			request = value;
			return true;
		});

		await approvedFileWrite({
			approvalId: "call_write",
			toolName: "write",
			projectRoot,
			absolutePath: path,
			content: "after",
			requestApproval,
		});

		expect(requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalId: "call_write",
				toolName: "write",
				summary: "write src.txt",
				targetPath: "src.txt",
				beforeSha256: digest("before"),
				afterSha256: digest("after"),
			}),
		);
		expect(request?.preview).toContain("before");
		expect(request?.preview).toContain("after");
		expect(readFileSync(path, "utf8")).toBe("after");
	});

	it("does not write after cancellation resolves a pending approval", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");
		writeFileSync(path, "before", "utf8");
		const controller = new AbortController();

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				signal: controller.signal,
				requestApproval: async () => {
					controller.abort(new Error("cancelled during approval"));
					return true;
				},
			}),
		).rejects.toThrow(/cancelled during approval/u);
		expect(readFileSync(path, "utf8")).toBe("before");
	});

	it("reviews a small edit to a file larger than the preview limit", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");
		const before = `${"unchanged line\n".repeat(3_000)}changed marker-A\ntail\n`;
		const after = before.replace("marker-A", "marker-B");
		writeFileSync(path, before, "utf8");
		let request: AgentToolApprovalRequest | undefined;

		await approvedFileWrite({
			approvalId: "call_edit",
			toolName: "edit",
			projectRoot,
			absolutePath: path,
			content: after,
			requestApproval: async (value) => {
				request = value;
				return true;
			},
		});

		expect(request?.beforeSha256).toBe(digest(before));
		expect(request?.afterSha256).toBe(digest(after));
		expect(request?.preview.length).toBeLessThanOrEqual(32_768);
		expect(request?.preview).toContain("changed marker-A");
		expect(request?.preview).toContain("changed marker-B");
		expect(readFileSync(path, "utf8")).toBe(after);
	});

	it("fails closed when the changed lines exceed the preview bound", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");
		writeFileSync(path, "a".repeat(32_768), "utf8");
		const requestApproval = vi.fn(async () => true);

		await expect(
			approvedFileWrite({
				approvalId: "call_edit",
				toolName: "edit",
				projectRoot,
				absolutePath: path,
				content: "b".repeat(32_768),
				requestApproval,
			}),
		).rejects.toThrow(/preview exceeds/u);
		expect(requestApproval).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe("a".repeat(32_768));
	});

	it("rejects a stale file after approval instead of overwriting it", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");
		writeFileSync(path, "before", "utf8");

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				requestApproval: async () => {
					writeFileSync(path, "raced", "utf8");
					return true;
				},
			}),
		).rejects.toThrow(/changed after approval/u);
		expect(readFileSync(path, "utf8")).toBe("raced");
	});

	it("canonicalizes a symlinked project root", async () => {
		const projectRoot = projectFixture();
		const aliasRoot = projectFixture();
		const alias = join(aliasRoot, "project");
		symlinkSync(projectRoot, alias, "dir");

		await approvedFileWrite({
			approvalId: "call_write",
			toolName: "write",
			projectRoot: alias,
			absolutePath: join(alias, "src.txt"),
			content: "content",
			requestApproval: async () => true,
		});

		expect(readFileSync(join(projectRoot, "src.txt"), "utf8")).toBe("content");
	});

	it("rejects an in-project symlink without writing its outside target", async () => {
		const projectRoot = projectFixture();
		const outsideRoot = projectFixture();
		const outsidePath = join(outsideRoot, "outside.txt");
		const path = join(projectRoot, "src.txt");
		writeFileSync(outsidePath, "outside", "utf8");
		symlinkSync(outsidePath, path);
		const requestApproval = vi.fn(async () => true);

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				requestApproval,
			}),
		).rejects.toThrow(/symbolic link/u);
		expect(requestApproval).not.toHaveBeenCalled();
		expect(readFileSync(outsidePath, "utf8")).toBe("outside");
	});

	it("rejects an in-project hard link without writing its outside inode", async () => {
		const projectRoot = projectFixture();
		const outsideRoot = projectFixture();
		const outsidePath = join(outsideRoot, "outside.txt");
		const path = join(projectRoot, "src.txt");
		writeFileSync(outsidePath, "outside", "utf8");
		linkSync(outsidePath, path);
		const requestApproval = vi.fn(async () => true);

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				requestApproval,
			}),
		).rejects.toThrow(/multiple links/u);
		expect(requestApproval).not.toHaveBeenCalled();
		expect(readFileSync(outsidePath, "utf8")).toBe("outside");
	});

	it("rejects an approved target replaced with identical content", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");
		const originalPath = join(projectRoot, "original.txt");
		writeFileSync(path, "before", "utf8");

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				requestApproval: async () => {
					renameSync(path, originalPath);
					writeFileSync(path, "before", "utf8");
					return true;
				},
			}),
		).rejects.toThrow(/changed after approval/u);
		expect(readFileSync(path, "utf8")).toBe("before");
	});

	it("creates a newly approved target exclusively", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "src.txt");

		await expect(
			approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "after",
				requestApproval: async () => {
					writeFileSync(path, "replacement", "utf8");
					return true;
				},
			}),
		).rejects.toThrow(/changed after approval/u);
		expect(readFileSync(path, "utf8")).toBe("replacement");
	});

	it("honors the process umask for a newly approved target", async () => {
		const projectRoot = projectFixture();
		const path = join(projectRoot, "private.txt");
		const previousUmask = process.umask(0o077);
		try {
			await approvedFileWrite({
				approvalId: "call_write",
				toolName: "write",
				projectRoot,
				absolutePath: path,
				content: "private",
				requestApproval: async () => true,
			});
		} finally {
			process.umask(previousUmask);
		}

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("never executes bash after rejection", async () => {
		const execute = vi.fn(async (): Promise<{ readonly exitCode: number | null }> => ({ exitCode: 0 }));
		await expect(
			approvedBashExecution({
				approvalId: "call_bash",
				projectRoot: projectFixture(),
				command: "rm -rf build",
				requestApproval: async () => false,
				execute,
			}),
		).rejects.toThrow(/rejected/u);
		expect(execute).not.toHaveBeenCalled();
	});

	it("never executes bash after cancellation resolves approval", async () => {
		const controller = new AbortController();
		const execute = vi.fn(async (): Promise<{ readonly exitCode: number | null }> => ({ exitCode: 0 }));

		await expect(
			approvedBashExecution({
				approvalId: "call_bash",
				projectRoot: projectFixture(),
				command: "touch approved",
				signal: controller.signal,
				requestApproval: async () => {
					controller.abort(new Error("cancelled during approval"));
					return true;
				},
				execute,
			}),
		).rejects.toThrow(/cancelled during approval/u);
		expect(execute).not.toHaveBeenCalled();
	});
});
