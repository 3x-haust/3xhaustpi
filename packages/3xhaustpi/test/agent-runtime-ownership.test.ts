import { beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeSessionManager = {
	readonly getCwd: () => string;
	readonly getSessionFile: () => string;
	readonly getSessionId: () => string;
};

type RuntimeSession = ReturnType<typeof createSession>;
type RuntimeMock = {
	session: RuntimeSession;
	readonly switchSession: ReturnType<typeof vi.fn>;
	readonly newSession: ReturnType<typeof vi.fn>;
	readonly dispose: ReturnType<typeof vi.fn>;
};
type Delegate = (request: { readonly workId: string; readonly objective: string }) => Promise<string>;
type RuntimeFactory = (options: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionManager: RuntimeSessionManager;
}) => Promise<{
	readonly session: RuntimeSession;
	readonly services: object;
	readonly diagnostics: readonly unknown[];
}>;

function createManager(
	sessionId: string,
	path = `/sessions/${sessionId}.jsonl`,
	cwd = "/tmp/project",
): RuntimeSessionManager {
	return {
		getCwd: () => cwd,
		getSessionFile: () => path,
		getSessionId: () => sessionId,
	};
}

function createSession(
	sessionManager: RuntimeSessionManager,
	model = { provider: "persisted-provider", id: "persisted-model", api: "openai-responses" },
	thinkingLevel: "off" | "low" | "medium" | "high" = "high",
) {
	return {
		agent: { streamFunction: vi.fn() },
		model,
		thinkingLevel,
		sessionManager,
		subscribe: vi.fn(() => vi.fn()),
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
	};
}

const mocks = vi.hoisted(() => ({
	cleanupSessionResources: vi.fn(),
	createAgentSessionFromServices: vi.fn(),
	createAgentSessionRuntime: vi.fn(),
	createAgentSessionServices: vi.fn(),
	createCredentialStore: vi.fn(),
	createModelRuntime: vi.fn(),
	createSessionManager: vi.fn(),
	delegate: new Map<"delegate", Delegate>().get("delegate"),
	delegateObjective: new Map<"objective", string>().get("objective"),
	listSessions: vi.fn(),
	openSessionManager: vi.fn(),
	runtimes: [] as RuntimeMock[],
}));

vi.mock("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: mocks.cleanupSessionResources,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: { create: mocks.createModelRuntime },
	SessionManager: {
		create: mocks.createSessionManager,
		list: mocks.listSessions,
		open: mocks.openSessionManager,
	},
	createAgentSessionRuntime: mocks.createAgentSessionRuntime,
	createAgentSessionFromServices: mocks.createAgentSessionFromServices,
	createAgentSessionServices: mocks.createAgentSessionServices,
	createBashToolDefinition: () => ({ name: "bash", executionMode: "sequential", execute: vi.fn() }),
	createEditToolDefinition: () => ({ name: "edit", executionMode: "sequential", execute: vi.fn() }),
	createLocalBashOperations: () => ({ exec: vi.fn() }),
	createWriteToolDefinition: () => ({ name: "write", executionMode: "sequential", execute: vi.fn() }),
	getAgentDir: () => "/tmp/agent",
}));

vi.mock("../src/agent-delegate-tool.ts", () => ({
	createDelegateTool: (input: {
		readonly delegate: (request: { readonly workId: string; readonly objective: string }) => Promise<string>;
	}) => {
		mocks.delegate = input.delegate;
		return { name: "delegate", executionMode: "parallel", execute: vi.fn() };
	},
}));

vi.mock("../src/provider-runtime.ts", () => ({
	createCredentialStore: mocks.createCredentialStore,
}));

import { AgentRuntimeHost } from "../src/agent-runtime.ts";
import { ProjectAgentRuntime } from "../src/agent-runtime-project.ts";
import type { AgentTaskRequest, AgentTaskResult } from "../src/agent-runtime-types.ts";

describe("project-scoped agent session runtime ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runtimes.length = 0;
		mocks.delegate = undefined;
		mocks.delegateObjective = undefined;
		mocks.createModelRuntime.mockResolvedValue({});
		mocks.createSessionManager.mockReturnValue(createManager("session_initial"));
		mocks.listSessions.mockResolvedValue([{ id: "session_persisted", path: "/sessions/session_persisted.jsonl" }]);
		mocks.openSessionManager.mockReturnValue(createManager("session_persisted"));
		mocks.createAgentSessionServices.mockImplementation(async ({ cwd }) => ({
			cwd,
			modelRuntime: {
				getAvailable: vi.fn().mockResolvedValue([
					{ provider: "persisted-provider", id: "persisted-model", api: "openai-responses" },
					{ provider: "explicit-provider", id: "explicit-model", api: "openai-responses" },
				]),
			},
			settingsManager: { getDefaultThinkingLevel: vi.fn().mockReturnValue("medium") },
			diagnostics: [],
		}));
		mocks.createAgentSessionFromServices.mockImplementation(async ({ sessionManager, model, thinkingLevel }) => {
			const session = createSession(sessionManager, model, thinkingLevel);
			session.prompt.mockImplementation(async () => {
				const objective = mocks.delegateObjective;
				mocks.delegateObjective = undefined;
				if (objective && mocks.delegate) {
					await mocks.delegate({ workId: "child_work", objective });
				}
			});
			return { session };
		});
		mocks.createAgentSessionRuntime.mockImplementation(
			async (factory: RuntimeFactory, options: Parameters<RuntimeFactory>[0]) => {
				const initial = await factory(options);
				const runtime = {
					session: initial.session,
					switchSession: vi.fn(async (path: string) => {
						const sessionManager = createManager("session_persisted", path, "/tmp/switched-project");
						const next = await factory({ ...options, cwd: sessionManager.getCwd(), sessionManager });
						runtime.session = next.session;
						return { cancelled: false };
					}),
					newSession: vi.fn(async () => {
						const sessionManager = createManager("session_new");
						const next = await factory({ ...options, cwd: sessionManager.getCwd(), sessionManager });
						runtime.session = next.session;
						return { cancelled: false };
					}),
					dispose: vi.fn(async () => {}),
				};
				mocks.runtimes.push(runtime);
				return runtime;
			},
		);
	});

	it("shares one runtime across root tasks and switches a requested persisted session through its lifecycle", async () => {
		// Given: one host receives two root tasks for the same project.
		const host = new AgentRuntimeHost();
		try {
			// When: the second task requests a different persisted session.
			await host.run({ projectRoot: "/tmp/project", objective: "first", onEvent: () => {} });
			await host.run({
				projectRoot: "/tmp/project",
				objective: "resume",
				sessionId: "session_persisted",
				onEvent: () => {},
			});
		} finally {
			await host.close();
		}

		// Then: the project runtime owns the switch instead of reopening a manager in task execution.
		expect(mocks.createAgentSessionRuntime).toHaveBeenCalledOnce();
		expect(mocks.runtimes[0]?.switchSession).toHaveBeenCalledWith("/sessions/session_persisted.jsonl");
		expect(mocks.runtimes[0]?.dispose).toHaveBeenCalledOnce();
		expect(mocks.createAgentSessionServices).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ cwd: "/tmp/switched-project" }),
		);
		expect(mocks.cleanupSessionResources).toHaveBeenCalledTimes(2);
	});

	it("restores persisted model and thinking unless the request explicitly overrides them", async () => {
		// Given: a project runtime starts and later resumes persisted sessions.
		const events: Array<{ readonly type: string; readonly provider?: string; readonly model?: string }> = [];
		const host = new AgentRuntimeHost();
		try {
			await host.run({ projectRoot: "/tmp/project", objective: "initial", onEvent: (event) => events.push(event) });

			// When: one resume has no override and another supplies all overrides.
			await host.run({
				projectRoot: "/tmp/project",
				objective: "persisted",
				sessionId: "session_persisted",
				onEvent: (event) => events.push(event),
			});
			await host.run({
				projectRoot: "/tmp/project",
				objective: "explicit",
				provider: "explicit-provider",
				model: "explicit-model",
				thinkingLevel: "off",
				sessionId: "session_persisted",
				onEvent: (event) => events.push(event),
			});
		} finally {
			await host.close();
		}

		// Then: SDK restoration remains unforced, while explicit values reach session creation.
		const persistedOptions = mocks.createAgentSessionFromServices.mock.calls[1]?.[0];
		expect(persistedOptions).not.toHaveProperty("model");
		expect(persistedOptions).not.toHaveProperty("thinkingLevel");
		expect(mocks.createAgentSessionFromServices.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({
				model: expect.objectContaining({ provider: "explicit-provider", id: "explicit-model" }),
				thinkingLevel: "off",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session.started",
				provider: "persisted-provider",
				model: "persisted-model",
			}),
		);
	});

	it("uses newSession for a later root task without a requested session", async () => {
		// Given: a project runtime has completed one root task.
		const host = new AgentRuntimeHost();
		try {
			await host.run({ projectRoot: "/tmp/project", objective: "first", onEvent: () => {} });

			// When: another task requests a fresh session.
			await host.run({ projectRoot: "/tmp/project", objective: "fresh", onEvent: () => {} });
		} finally {
			await host.close();
		}

		// Then: replacement uses the runtime lifecycle and recreates cwd-bound services.
		expect(mocks.runtimes[0]?.newSession).toHaveBeenCalledOnce();
		expect(mocks.createModelRuntime).toHaveBeenCalledOnce();
		expect(mocks.createAgentSessionServices).toHaveBeenCalledTimes(2);
	});

	it("runs a delegated child in an isolated runtime without recursively queueing on the project owner", async () => {
		// Given: the root session delegates during its active prompt.
		mocks.delegateObjective = "inspect child evidence";
		const host = new AgentRuntimeHost();
		try {
			// When: the delegated child completes before the root prompt returns.
			await host.run({ projectRoot: "/tmp/project", objective: "delegate", onEvent: () => {} });
		} finally {
			await host.close();
		}

		// Then: root and child have distinct runtimes and both are disposed.
		expect(mocks.createAgentSessionRuntime).toHaveBeenCalledTimes(2);
		expect(mocks.createAgentSessionFromServices.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				model: expect.objectContaining({ provider: "persisted-provider", id: "persisted-model" }),
				thinkingLevel: "low",
			}),
		);
		expect(mocks.runtimes[0]?.dispose).toHaveBeenCalledOnce();
		expect(mocks.runtimes[1]?.dispose).toHaveBeenCalledOnce();
	});

	it("propagates the root cancellation signal into delegated children", async () => {
		const controller = new AbortController();
		const runChild = vi.fn(
			async (_request: AgentTaskRequest): Promise<AgentTaskResult> => ({
				sessionId: "session_child",
				outcome: "completed",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		mocks.delegateObjective = "inspect child evidence";
		const runtime = new ProjectAgentRuntime({
			projectRoot: "/tmp/project",
			modelRuntime: mocks.createModelRuntime(),
			runChild,
			registerCacheAffinity: () => {},
		});

		await runtime.run({
			projectRoot: "/tmp/project",
			objective: "delegate",
			signal: controller.signal,
			onEvent: () => {},
		});

		expect(runChild).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
		await runtime.dispose();
	});
});
