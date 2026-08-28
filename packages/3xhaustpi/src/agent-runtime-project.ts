import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { recoverApprovedFileTransactions } from "./agent-approved-file-transaction.ts";
import { createApprovedAgentTools } from "./agent-approved-tools.ts";
import { warmAgentPromptCache } from "./agent-cache-warm.ts";
import { createDelegateTool } from "./agent-delegate-tool.ts";
import { createDelegatedAgentEventProjection } from "./agent-delegation-events.ts";
import { executeAgentTask } from "./agent-runtime-execution.ts";
import { installProviderCacheRouting, providerAccountCacheAffinity } from "./agent-runtime-provider.ts";
import { findAgentSessionPath, openAgentSessionManager } from "./agent-runtime-session-lookup.ts";
import { createNativeSystemPromptPolicy } from "./agent-runtime-system-prompt.ts";
import type {
	AgentCacheWarmResult,
	AgentCompactConversationResult,
	AgentTaskRequest,
	AgentTaskResult,
} from "./agent-runtime-types.ts";

class AgentRuntimeStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentRuntimeStateError";
	}
}

class AgentModelUnavailableError extends Error {
	constructor(provider: string | undefined, model: string | undefined) {
		super(`Requested agent model is unavailable: ${provider ?? "default"}/${model ?? "default"}`);
		this.name = "AgentModelUnavailableError";
	}
}

export interface ProjectAgentRuntimeOptions {
	readonly projectRoot: string;
	readonly userRoot?: string;
	readonly modelRuntime: Promise<ModelRuntime>;
	readonly runChild: (request: AgentTaskRequest) => Promise<AgentTaskResult>;
	readonly registerCacheAffinity: (cacheAffinity: string) => void;
}

/** Serial owner for the replaceable AgentSessionRuntime of one project. */
export class ProjectAgentRuntime {
	private readonly options: ProjectAgentRuntimeOptions;
	private runtime: AgentSessionRuntime | undefined;
	private activeRequest: AgentTaskRequest | undefined;
	private globalInstructions: string | undefined;
	private tail: Promise<void> = Promise.resolve();

	constructor(options: ProjectAgentRuntimeOptions) {
		this.options = options;
	}

	private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		sessionManager,
		sessionStartEvent,
	}) => {
		const request = this.activeRequest;
		if (!request) throw new AgentRuntimeStateError("Agent session creation requires an active task");
		await recoverApprovedFileTransactions(this.options.projectRoot);
		const nativePromptPolicy = this.options.userRoot
			? createNativeSystemPromptPolicy(this.options.userRoot)
			: undefined;
		const services = await createAgentSessionServices({
			cwd,
			modelRuntime: await this.options.modelRuntime,
			...(nativePromptPolicy ? { resourceLoaderOptions: nativePromptPolicy.resourceLoaderOptions } : {}),
		});
		this.globalInstructions = nativePromptPolicy?.currentGlobalPrompt()?.instructions;
		const hasExplicitModel = request.provider !== undefined || request.model !== undefined;
		const available = hasExplicitModel ? await services.modelRuntime.getAvailable(request.provider) : [];
		const model = hasExplicitModel
			? available.find(
					(candidate) =>
						(request.provider === undefined || candidate.provider === request.provider) &&
						(request.model === undefined || candidate.id === request.model),
				)
			: undefined;
		if (hasExplicitModel && !model) throw new AgentModelUnavailableError(request.provider, request.model);

		const delegationDepth = request.delegationDepth ?? 0;
		const customTools = createApprovedAgentTools({
			projectRoot: this.options.projectRoot,
			requestApproval: request.requestToolApproval,
			signal: request.signal,
		});
		if (delegationDepth < 1) {
			customTools.push(
				createDelegateTool({
					delegate: async ({ workId, objective }) => {
						const childEvents = createDelegatedAgentEventProjection(workId, objective, request.onEvent);
						const activeModel = this.runtime?.session.model ?? model;
						const child = await this.options.runChild({
							projectRoot: this.options.projectRoot,
							objective,
							...(activeModel ? { provider: activeModel.provider, model: activeModel.id } : {}),
							...(request.accountId ? { accountId: request.accountId } : {}),
							thinkingLevel: "low",
							delegationDepth: delegationDepth + 1,
							signal: request.signal,
							onEvent: childEvents.onEvent,
						});
						return childEvents.message() || `Delegated agent ${child.outcome}`;
					},
				}),
			);
		}
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			...(model ? { model } : {}),
			...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
			tools: delegationDepth < 1 ? ["read", "bash", "edit", "write", "delegate"] : ["read"],
			customTools,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	run(request: AgentTaskRequest): Promise<AgentTaskResult> {
		const result = this.tail.then(() => this.runExclusive(request));
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	compact(request: AgentTaskRequest, instructions?: string): Promise<AgentCompactConversationResult> {
		const result = this.tail.then(() => this.compactExclusive(request, instructions));
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	warmCache(request: AgentTaskRequest): Promise<AgentCacheWarmResult> {
		const result = this.tail.then(() => this.warmCacheExclusive(request));
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async selectRuntime(request: AgentTaskRequest): Promise<void> {
		if (!this.runtime) {
			const sessionManager = await openAgentSessionManager(this.options.projectRoot, request.sessionId);
			this.runtime = await createAgentSessionRuntime(this.createRuntime, {
				cwd: sessionManager.getCwd(),
				agentDir: getAgentDir(),
				sessionManager,
			});
		} else if (request.sessionId) {
			const sessionPath = await findAgentSessionPath(this.options.projectRoot, request.sessionId);
			const switched = await this.runtime.switchSession(sessionPath);
			if (switched.cancelled) throw new AgentRuntimeStateError("Agent session switch was cancelled");
		} else {
			const switched = await this.runtime.newSession();
			if (switched.cancelled) throw new AgentRuntimeStateError("Agent new session was cancelled");
		}
	}

	private async runExclusive(request: AgentTaskRequest): Promise<AgentTaskResult> {
		this.activeRequest = request;
		try {
			await this.selectRuntime(request);
			const runtime = this.runtime;
			if (!runtime) throw new AgentRuntimeStateError("Agent runtime was not initialized");
			return executeAgentTask(request, this.options.projectRoot, {
				session: runtime.session,
				registerCacheAffinity: this.options.registerCacheAffinity,
				...(this.globalInstructions ? { globalInstructions: this.globalInstructions } : {}),
			});
		} finally {
			this.activeRequest = undefined;
		}
	}

	private async compactExclusive(
		request: AgentTaskRequest,
		instructions?: string,
	): Promise<AgentCompactConversationResult> {
		if (!request.sessionId) throw new AgentRuntimeStateError("Conversation compaction requires a session");
		this.activeRequest = request;
		try {
			await this.selectRuntime(request);
			const runtime = this.runtime;
			if (!runtime) throw new AgentRuntimeStateError("Agent runtime was not initialized");
			const model = runtime.session.model;
			if (!model) throw new AgentRuntimeStateError("Conversation compaction requires an active model");
			const cacheAffinity = providerAccountCacheAffinity(
				this.options.projectRoot,
				model.provider,
				model.id,
				request.accountId,
				runtime.session.systemPrompt,
			);
			this.options.registerCacheAffinity(`${cacheAffinity}_compaction`);
			installProviderCacheRouting(runtime.session, cacheAffinity, undefined, this.globalInstructions);
			const result = await runtime.session.compact(instructions);
			return {
				tokensBefore: result.tokensBefore,
				...(result.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
			};
		} finally {
			this.activeRequest = undefined;
		}
	}

	private async warmCacheExclusive(request: AgentTaskRequest): Promise<AgentCacheWarmResult> {
		if (!request.sessionId) throw new AgentRuntimeStateError("Cache warming requires a session");
		this.activeRequest = request;
		try {
			await this.selectRuntime(request);
			const runtime = this.runtime;
			if (!runtime) throw new AgentRuntimeStateError("Agent runtime was not initialized");
			if (!request.signal) throw new AgentRuntimeStateError("Cache warming requires cancellation ownership");
			const model = runtime.session.model;
			if (!model) throw new AgentRuntimeStateError("Cache warming requires an active model");
			const cacheAffinity = providerAccountCacheAffinity(
				this.options.projectRoot,
				model.provider,
				model.id,
				request.accountId,
				runtime.session.systemPrompt,
			);
			this.options.registerCacheAffinity(cacheAffinity);
			installProviderCacheRouting(runtime.session, cacheAffinity, undefined, this.globalInstructions);
			return warmAgentPromptCache(runtime.session, request.signal);
		} finally {
			this.activeRequest = undefined;
		}
	}

	async dispose(): Promise<void> {
		await this.tail;
		await this.runtime?.dispose();
		this.runtime = undefined;
	}
}
