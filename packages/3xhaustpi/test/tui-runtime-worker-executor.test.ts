import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	close: vi.fn(async () => {}),
	runAgent: vi.fn(),
	runSemantic: vi.fn(async () => "legacy result"),
}));

vi.mock("../src/agent-runtime.ts", () => ({
	AgentRuntimeHost: class {
		run = mocks.runAgent;
		close = mocks.close;
	},
}));

vi.mock("../src/coding-runtime.ts", () => ({
	resumeCodingTask: vi.fn(),
	runCodingTask: mocks.runSemantic,
}));

import { TuiRuntimeWorkerExecutor } from "../src/tui-runtime-worker-executor.ts";
import { WorkerRunState } from "../src/tui-runtime-worker-run-state.ts";

describe("TUI native runtime ownership", () => {
	it("does not fall back into a separate semantic conversation", async () => {
		mocks.runAgent.mockRejectedValueOnce(new Error("native runtime failed"));
		const state = new WorkerRunState();
		const run = state.createRun("run_native_only");
		if (!run) throw new Error("Expected active worker run");
		const executor = new TuiRuntimeWorkerExecutor(state, () => {});

		await expect(
			executor.execute(
				{
					mode: "run",
					projectRoot: "/tmp/project",
					objective: "inspect",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				},
				run,
			),
		).rejects.toThrow(/native runtime failed/u);
		expect(mocks.runSemantic).not.toHaveBeenCalled();
		await executor.close();
	});
});
