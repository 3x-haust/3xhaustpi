import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./harness.ts";

const io = vi.hoisted(() => ({
	lineHandler: undefined as ((line: string) => void) | undefined,
	onOutput: undefined as ((record: Record<string, unknown>) => void) | undefined,
	records: [] as Record<string, unknown>[],
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		const record = JSON.parse(line) as Record<string, unknown>;
		io.records.push(record);
		io.onOutput?.(record);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, handler: (line: string) => void) => {
		io.lineHandler = handler;
		return () => {};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

it("returns finalized cache buckets over get_session_stats at completion and after JSONL reload", async () => {
	const harness = await createHarness({ persistSession: true });
	const usage: Usage = {
		input: 600,
		output: 20,
		cacheRead: 7400,
		cacheWrite: 2000,
		totalTokens: 10020,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	};
	harness.setResponses([fauxAssistantMessage("response", { usage })]);
	const watchedSignals = ["SIGTERM", "SIGHUP"] as const;
	const previousSignals = new Map(watchedSignals.map((signal) => [signal, new Set(process.listeners(signal))]));
	const previousInputEnd = new Set(process.stdin.listeners("end"));
	try {
		const runtime = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		void runRpcMode(runtime);
		await vi.waitFor(() => expect(io.lineHandler).toBeDefined());
		io.onOutput = (record) => {
			if (record.type === "message_end" && (record.message as { role?: string }).role === "assistant") {
				io.lineHandler?.(JSON.stringify({ id: "completion", type: "get_session_stats" }));
			}
		};
		await harness.session.prompt("hello");
		harness.sessionManager.setSessionFile(harness.session.sessionFile!);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		io.lineHandler?.(JSON.stringify({ id: "reload", type: "get_session_stats" }));
		await vi.waitFor(() => {
			const responses = io.records.filter((record) => record.command === "get_session_stats");
			expect(responses.map((record) => record.id)).toEqual(["completion", "reload"]);
			for (const response of responses) {
				expect(response).toMatchObject({
					type: "response",
					success: true,
					data: {
						assistantMessages: 1,
						tokens: { input: 600, output: 20, cacheRead: 7400, cacheWrite: 2000, total: 10020 },
						cost: 1,
					},
				});
			}
		});
	} finally {
		harness.cleanup();
		for (const signal of watchedSignals) {
			for (const listener of process.listeners(signal)) {
				if (!previousSignals.get(signal)?.has(listener)) process.off(signal, listener as () => void);
			}
		}
		for (const listener of process.stdin.listeners("end")) {
			if (!previousInputEnd.has(listener)) process.stdin.off("end", listener as () => void);
		}
		io.lineHandler = undefined;
		io.onOutput = undefined;
		io.records = [];
	}
});
