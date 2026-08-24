import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskEvent } from "../src/coding-runtime.ts";

const mocks = vi.hoisted(() => ({
	cleanupSessionResources: vi.fn(),
	createAgentSessionFromServices: vi.fn(),
	createAgentSessionRuntime: vi.fn(),
	createAgentSessionServices: vi.fn(),
	createCredentialStore: vi.fn(),
	createModelRuntime: vi.fn(),
	createSessionManager: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: mocks.cleanupSessionResources,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: { create: mocks.createModelRuntime },
	SessionManager: { create: mocks.createSessionManager },
	createAgentSessionRuntime: mocks.createAgentSessionRuntime,
	createBashToolDefinition: () => ({ name: "bash", executionMode: "sequential", execute: vi.fn() }),
	createEditToolDefinition: () => ({ name: "edit", executionMode: "sequential", execute: vi.fn() }),
	createLocalBashOperations: () => ({ exec: vi.fn() }),
	createWriteToolDefinition: () => ({ name: "write", executionMode: "sequential", execute: vi.fn() }),
	createAgentSessionFromServices: mocks.createAgentSessionFromServices,
	createAgentSessionServices: mocks.createAgentSessionServices,
	getAgentDir: () => "/tmp/3xhaustpi-agent-runtime-events",
}));

vi.mock("../src/provider-runtime.ts", () => ({
	createCredentialStore: mocks.createCredentialStore,
}));

import { runAgentTask } from "../src/agent-runtime.ts";

const usage = {
	input: 4_234,
	output: 110,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 4_344,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("native agent event projection", () => {
	let sessionMock: {
		readonly model: { readonly provider: string; readonly id: string; readonly api: string };
		readonly sessionManager: { readonly getSessionId: () => string };
		readonly thinkingLevel: "medium";
		readonly agent: {
			streamFunction: ReturnType<typeof vi.fn>;
			beforeToolCall?: (
				input: {
					readonly toolCall: { readonly id: string; readonly name: string };
					readonly args: unknown;
				},
				signal?: AbortSignal,
			) => Promise<{ readonly block?: boolean; readonly reason?: string } | undefined>;
		};
		readonly subscribe: ReturnType<typeof vi.fn>;
		readonly prompt: ReturnType<typeof vi.fn>;
		readonly abort: ReturnType<typeof vi.fn>;
		readonly dispose: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		const model = {
			provider: "openai-codex",
			id: "gpt-5.3-codex-spark",
			api: "openai-codex-responses",
		};
		let subscriber: ((event: unknown) => void) | undefined;
		sessionMock = {
			model,
			sessionManager: { getSessionId: () => "session_fixture" },
			thinkingLevel: "medium",
			agent: { streamFunction: vi.fn() },
			subscribe: vi.fn((listener) => {
				subscriber = listener;
				return vi.fn();
			}),
			prompt: vi.fn(async () => {
				const message = {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "" },
						{ type: "text", text: "안녕" },
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					responseId: "response_fixture",
					usage,
					stopReason: "stop",
					timestamp: 1,
				};
				subscriber?.({ type: "message_start", message });
				subscriber?.({ type: "message_end", message });
			}),
			abort: vi.fn(),
			dispose: vi.fn(),
		};
		mocks.createCredentialStore.mockReturnValue({});
		mocks.createModelRuntime.mockResolvedValue({});
		mocks.createAgentSessionServices.mockResolvedValue({
			modelRuntime: { getAvailable: vi.fn().mockResolvedValue([model]) },
			settingsManager: { getDefaultThinkingLevel: vi.fn().mockReturnValue("medium") },
		});
		mocks.createSessionManager.mockReturnValue({
			getCwd: () => "/tmp/project",
			getSessionFile: () => "/tmp/session_fixture.jsonl",
			getSessionId: () => "session_fixture",
		});
		mocks.createAgentSessionFromServices.mockResolvedValue({ session: sessionMock });
		mocks.createAgentSessionRuntime.mockImplementation(async (factory, options) => {
			const initial = await factory(options);
			const runtime = {
				session: initial.session,
				newSession: vi.fn(async () => {
					const next = await factory({ ...options, sessionManager: mocks.createSessionManager() });
					runtime.session = next.session;
					return { cancelled: false };
				}),
				switchSession: vi.fn(async () => ({ cancelled: false })),
				dispose: vi.fn(async () => {
					runtime.session.dispose();
				}),
			};
			return runtime;
		});
	});

	it("emits the final assistant text when the provider sends no text deltas", async () => {
		const events: CodingTaskEvent[] = [];

		await runAgentTask({
			projectRoot: "/tmp/project",
			objective: "ㅎㅇ 한 단어로 답해",
			provider: "openai-codex",
			model: "gpt-5.3-codex-spark",
			onEvent: (event) => events.push(event),
		});

		expect(events).toContainEqual({ type: "assistant.message", text: "안녕" });
		expect(events).toContainEqual({
			type: "model.completed",
			responseId: "response_fixture",
			usage: { input: 4_234, output: 110, cacheRead: 0, cacheWrite: 0 },
			durationMs: expect.any(Number),
		});
		expect(events.findIndex((event) => event.type === "assistant.message")).toBeLessThan(
			events.findIndex((event) => event.type === "model.completed"),
		);
	});

	it("preserves tool identity and measures its real duration", async () => {
		const events: CodingTaskEvent[] = [];
		const now = vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(24.5);
		sessionMock.prompt.mockImplementationOnce(async () => {
			const listener = sessionMock.subscribe.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
			listener?.({ type: "tool_execution_start", toolCallId: "call_read", toolName: "read", args: {} });
			listener?.({
				type: "tool_execution_end",
				toolCallId: "call_read",
				toolName: "read",
				result: {},
				isError: false,
			});
		});

		await runAgentTask({
			projectRoot: "/tmp/project",
			objective: "inspect",
			provider: "openai-codex",
			model: "gpt-5.3-codex-spark",
			onEvent: (event) => events.push(event),
		});
		now.mockRestore();

		expect(events).toContainEqual({
			type: "work.started",
			workId: "call_read",
			kind: "tool",
			label: "read",
		});
		expect(events).toContainEqual({
			type: "work.completed",
			workId: "call_read",
			success: true,
			durationMs: 14.5,
			summary: "read done",
		});
	});

	it("installs host-owned mutating tools instead of a generic approval hook", async () => {
		const requestToolApproval = vi.fn(async () => false);

		await runAgentTask({
			projectRoot: "/tmp/project",
			objective: "edit",
			provider: "openai-codex",
			model: "gpt-5.3-codex-spark",
			onEvent: () => {},
			requestToolApproval,
		});

		expect(mocks.createAgentSessionFromServices).toHaveBeenCalledWith(
			expect.objectContaining({
				customTools: expect.arrayContaining([expect.objectContaining({ name: "delegate" })]),
			}),
		);
		expect(requestToolApproval).not.toHaveBeenCalled();
	});

	it("commits the provider effect boundary before prompting", async () => {
		const sequence: string[] = [];
		const recordEffectBoundary = vi.fn(async () => {
			sequence.push("effect");
		});
		sessionMock.prompt.mockImplementationOnce(async () => {
			sequence.push("prompt");
		});

		await runAgentTask({
			projectRoot: "/tmp/project",
			objective: "inspect",
			provider: "openai-codex",
			model: "gpt-5.3-codex-spark",
			onEvent: () => {},
			recordEffectBoundary,
		});

		expect(recordEffectBoundary).toHaveBeenCalledWith({
			effectId: "provider_session_fixture",
			kind: "provider",
		});
		expect(sequence).toEqual(["effect", "prompt"]);
	});

	it("rejects a pre-aborted task before effect recording or provider dispatch", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled before dispatch"));
		const recordEffectBoundary = vi.fn(async () => {});

		await expect(
			runAgentTask({
				projectRoot: "/tmp/project",
				objective: "inspect",
				provider: "openai-codex",
				model: "gpt-5.3-codex-spark",
				signal: controller.signal,
				onEvent: () => {},
				recordEffectBoundary,
			}),
		).rejects.toThrow(/cancelled before dispatch/u);

		expect(sessionMock.abort).toHaveBeenCalledOnce();
		expect(recordEffectBoundary).not.toHaveBeenCalled();
		expect(sessionMock.prompt).not.toHaveBeenCalled();
	});

	it("does not dispatch after cancellation during effect recording", async () => {
		const controller = new AbortController();
		let releaseEffect!: () => void;
		let signalEffectStarted!: () => void;
		const effectStarted = new Promise<void>((resolve) => {
			signalEffectStarted = resolve;
		});
		const recordEffectBoundary = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseEffect = resolve;
					signalEffectStarted();
				}),
		);
		const execution = runAgentTask({
			projectRoot: "/tmp/project",
			objective: "inspect",
			provider: "openai-codex",
			model: "gpt-5.3-codex-spark",
			signal: controller.signal,
			onEvent: () => {},
			recordEffectBoundary,
		});
		await effectStarted;

		controller.abort(new Error("cancelled during effect recording"));
		releaseEffect();

		await expect(execution).rejects.toThrow(/cancelled during effect recording/u);
		expect(sessionMock.prompt).not.toHaveBeenCalled();
	});
});
