import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolApprovalRequest } from "../src/agent-approved-tools.ts";

const mocks = vi.hoisted(() => ({
	resumeCodingTask: vi.fn(),
	runAgentTask: vi.fn(),
	runCodingTask: vi.fn(),
}));

vi.mock("../src/agent-runtime.ts", () => ({
	AgentRuntimeHost: class {
		run = mocks.runAgentTask;
		close = vi.fn(async () => {});
	},
	runAgentTask: mocks.runAgentTask,
}));
vi.mock("../src/coding-runtime.ts", () => ({
	resumeCodingTask: mocks.resumeCodingTask,
	runCodingTask: mocks.runCodingTask,
}));
vi.mock("../src/cli-output.ts", () => ({ printCodingTaskEvent: vi.fn() }));
vi.mock("../src/tui.ts", () => ({ runTui: vi.fn() }));

import { requestCliToolApproval, runCommand } from "../src/cli-run.ts";

const request: AgentToolApprovalRequest = {
	approvalId: "call_bash",
	toolName: "bash",
	summary: "bash /tmp/project",
	preview: "printf 'first'\nprintf 'second'",
};

const command = {
	kind: "run" as const,
	prompt: "make the change",
	resume: false,
	approve: true,
};

describe("non-interactive native tool approval", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("prints the complete bounded review and fails closed without an operator terminal", async () => {
		const write = vi.fn();
		const question = vi.fn(async () => "yes");

		await expect(requestCliToolApproval(request, { interactive: false, write, question })).resolves.toBe(false);

		expect(write).toHaveBeenCalledOnce();
		expect(write.mock.calls[0]?.[0]).toContain("Tool approval  bash");
		expect(write.mock.calls[0]?.[0]).toContain("printf 'first'\nprintf 'second'");
		expect(question).not.toHaveBeenCalled();
	});

	it("accepts only an explicit supported operator decision after review", async () => {
		const write = vi.fn();

		await expect(
			requestCliToolApproval(request, { interactive: true, write, question: async () => "yes" }),
		).resolves.toBe(true);
		await expect(
			requestCliToolApproval(request, { interactive: true, write, question: async () => "approve" }),
		).resolves.toBe(false);
	});

	it("does not turn --approve into native bash/edit/write approval", async () => {
		let approved: boolean | undefined;
		mocks.runAgentTask.mockImplementationOnce(async (task) => {
			approved = await task.requestToolApproval(request);
			return {
				sessionId: "session_fixture",
				outcome: "completed",
				usage: { input: 0, output: 0, cacheRead: 0 },
			};
		});

		await runCommand(command, "/tmp/project");

		expect(approved).toBe(false);
	});

	it("preserves --approve for the exact-patch fallback and sanitizes its error", async () => {
		mocks.runAgentTask.mockRejectedValueOnce(new Error("provider\u001b[31m failed"));
		mocks.runCodingTask.mockResolvedValueOnce({});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await runCommand(command, "/tmp/project");

		expect(mocks.runCodingTask).toHaveBeenCalledWith(expect.objectContaining({ approve: true }));
		expect(error).toHaveBeenCalledWith("Agent runtime unavailable, falling back: provider failed");
		error.mockRestore();
	});
});
