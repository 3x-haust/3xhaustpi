import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProjectAgentRuntime } from "./agent-runtime-project.ts";
import { canonicalProjectRoot } from "./agent-runtime-session-lookup.ts";
import type { AgentTaskRequest, AgentTaskResult } from "./agent-runtime-types.ts";
import { createCredentialStore } from "./provider-runtime.ts";

/** Persistent host that owns one serial AgentSessionRuntime per project. */
export class AgentRuntimeHost {
	private modelRuntimePromise: Promise<ModelRuntime> | undefined;
	private readonly runtimesByProject = new Map<string, ProjectAgentRuntime>();
	private readonly cacheAffinities = new Set<string>();
	private readonly activeTasks = new Set<Promise<AgentTaskResult>>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	private getModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntimePromise ??= ModelRuntime.create({
			credentials: createCredentialStore(),
		});
		return this.modelRuntimePromise;
	}

	private getProjectRuntime(projectRoot: string): ProjectAgentRuntime {
		let runtime = this.runtimesByProject.get(projectRoot);
		if (!runtime) {
			runtime = new ProjectAgentRuntime({
				projectRoot,
				modelRuntime: this.getModelRuntime(),
				runChild: (request) => this.runIsolatedChild(request),
				registerCacheAffinity: (affinity) => this.cacheAffinities.add(affinity),
			});
			this.runtimesByProject.set(projectRoot, runtime);
		}
		return runtime;
	}

	async run(request: AgentTaskRequest): Promise<AgentTaskResult> {
		if (this.closed) throw new Error("AgentRuntimeHost is closed");
		const projectRoot = canonicalProjectRoot(request.projectRoot);
		const task = this.getProjectRuntime(projectRoot).run({ ...request, projectRoot });
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
			modelRuntime: this.getModelRuntime(),
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
		const runtimes = [...this.runtimesByProject.values()];
		this.runtimesByProject.clear();
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
