import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAuxiliaryQuestion } from "./agent-auxiliary.ts";
import { runEphemeralQuestion } from "./agent-ephemeral.ts";
import { ProjectAgentRuntime } from "./agent-runtime-project.ts";
import { canonicalProjectRoot } from "./agent-runtime-session-lookup.ts";
import type {
	AgentAuxiliaryRequest,
	AgentCacheWarmRequest,
	AgentCacheWarmResult,
	AgentCompactConversationRequest,
	AgentCompactConversationResult,
	AgentEphemeralQuestionRequest,
	AgentTaskRequest,
	AgentTaskResult,
} from "./agent-runtime-types.ts";
import { resolveUserDataDirectory } from "./identity.ts";
import { ProjectSerialQueue } from "./project-serial-queue.ts";
import { createCredentialStore } from "./provider-runtime.ts";

export interface AgentRuntimeHostOptions {
	readonly userRoot?: string;
}

/** Persistent host that owns one serial AgentSessionRuntime per project. */
export class AgentRuntimeHost {
	private readonly modelRuntimePromises = new Map<string, Promise<ModelRuntime>>();
	private readonly projectQueue = new ProjectSerialQueue();
	private readonly auxiliaryQueue = new ProjectSerialQueue();
	private readonly runtimesByProject = new Map<string, ProjectAgentRuntime>();
	private readonly cacheAffinities = new Set<string>();
	private readonly activeTasks = new Set<Promise<unknown>>();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private readonly userRoot: string;

	constructor(options: AgentRuntimeHostOptions = {}) {
		this.userRoot = options.userRoot ?? resolveUserDataDirectory();
	}

	private getModelRuntime(accountId: string | undefined): Promise<ModelRuntime> {
		const key = accountId ?? "default";
		let runtime = this.modelRuntimePromises.get(key);
		if (!runtime) {
			runtime = ModelRuntime.create({ credentials: createCredentialStore(accountId) });
			this.modelRuntimePromises.set(key, runtime);
		}
		return runtime;
	}

	private getProjectRuntime(projectRoot: string, accountId: string | undefined): ProjectAgentRuntime {
		const runtimeKey = `${projectRoot}\u0000${accountId ?? "default"}`;
		let runtime = this.runtimesByProject.get(runtimeKey);
		if (!runtime) {
			runtime = new ProjectAgentRuntime({
				projectRoot,
				userRoot: this.userRoot,
				modelRuntime: this.getModelRuntime(accountId),
				runChild: (request) => this.runIsolatedChild(request),
				registerCacheAffinity: (affinity) => this.cacheAffinities.add(affinity),
			});
			this.runtimesByProject.set(runtimeKey, runtime);
		}
		return runtime;
	}

	async run(request: AgentTaskRequest): Promise<AgentTaskResult> {
		if (this.closed) throw new Error("AgentRuntimeHost is closed");
		const projectRoot = canonicalProjectRoot(request.projectRoot);
		const task = this.projectQueue.run(projectRoot, () =>
			this.getProjectRuntime(projectRoot, request.accountId).run({ ...request, projectRoot }),
		);
		this.activeTasks.add(task);
		try {
			return await task;
		} finally {
			this.activeTasks.delete(task);
		}
	}

	runSideQuestion(request: AgentEphemeralQuestionRequest): Promise<string> {
		if (this.closed) throw new Error("AgentRuntimeHost is closed");
		return runEphemeralQuestion(this.getModelRuntime(request.accountId), request, this.userRoot, (affinity) =>
			this.cacheAffinities.add(affinity),
		);
	}

	runAuxiliary(request: AgentAuxiliaryRequest): Promise<string> {
		if (this.closed) return Promise.reject(new Error("AgentRuntimeHost is closed"));
		const projectRoot = canonicalProjectRoot(request.projectRoot);
		const task = this.auxiliaryQueue.run(projectRoot, () =>
			runAuxiliaryQuestion(
				this.getModelRuntime(request.accountId),
				{ ...request, projectRoot },
				this.userRoot,
				(affinity) => this.cacheAffinities.add(affinity),
			),
		);
		this.activeTasks.add(task);
		return task.finally(() => this.activeTasks.delete(task));
	}

	async compactConversation(request: AgentCompactConversationRequest): Promise<AgentCompactConversationResult> {
		if (this.closed) throw new Error("AgentRuntimeHost is closed");
		const projectRoot = canonicalProjectRoot(request.projectRoot);
		const task = this.projectQueue.run(projectRoot, () =>
			this.getProjectRuntime(projectRoot, request.accountId).compact(
				{
					...request,
					projectRoot,
					objective: "",
					onEvent: () => {},
				},
				request.instructions,
			),
		);
		this.activeTasks.add(task);
		try {
			return await task;
		} finally {
			this.activeTasks.delete(task);
		}
	}

	async warmCache(request: AgentCacheWarmRequest): Promise<AgentCacheWarmResult> {
		if (this.closed) throw new Error("AgentRuntimeHost is closed");
		const projectRoot = canonicalProjectRoot(request.projectRoot);
		const task = this.projectQueue.run(projectRoot, () =>
			this.getProjectRuntime(projectRoot, request.accountId).warmCache({
				...request,
				projectRoot,
				objective: "",
				onEvent: () => {},
			}),
		);
		this.activeTasks.add(task);
		try {
			return await task;
		} finally {
			this.activeTasks.delete(task);
		}
	}

	private async runIsolatedChild(request: AgentTaskRequest): Promise<AgentTaskResult> {
		const projectRoot = canonicalProjectRoot(request.projectRoot);
		const runtime = new ProjectAgentRuntime({
			projectRoot,
			userRoot: this.userRoot,
			modelRuntime: this.getModelRuntime(request.accountId),
			runChild: (child) => this.runIsolatedChild(child),
			registerCacheAffinity: (affinity) => this.cacheAffinities.add(affinity),
		});
		try {
			return await runtime.run({ ...request, projectRoot });
		} finally {
			await runtime.dispose();
		}
	}

	async close(): Promise<void> {
		if (!this.closePromise) {
			this.closed = true;
			this.closePromise = this.closeHost();
		}
		return this.closePromise;
	}

	private async closeHost(): Promise<void> {
		await Promise.allSettled([...this.activeTasks]);
		await this.projectQueue.idle();
		await this.auxiliaryQueue.idle();
		const runtimes = [...this.runtimesByProject.values()];
		this.runtimesByProject.clear();
		this.modelRuntimePromises.clear();
		const affinities = [...this.cacheAffinities];
		this.cacheAffinities.clear();
		const settled = await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
		const errors: unknown[] = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		for (const affinity of affinities) {
			try {
				cleanupSessionResources(affinity);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "Failed to cleanup agent runtime resources");
	}
}
