import { randomUUID } from "node:crypto";
import { parseProjectId } from "@3xhaust/semantic-contract";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { semanticProviderSessionId } from "../../pi-adapter/src/index.ts";
import { parseDurableCodingTaskCheckpoint } from "./coding-runtime-checkpoint.ts";
import type {
	CodingTaskEvent,
	CodingTaskInput,
	CodingTaskResult,
	ResumeCodingTaskInput,
} from "./coding-runtime-contracts.ts";
import { runPatchFlow } from "./coding-runtime-patch-flow.ts";
import { prepareProjectEvidence } from "./coding-runtime-project.ts";
import { configuredPythonConcurrency, digest, providerCacheSessionId } from "./coding-runtime-provider.ts";
import { resumeCodingTaskWith } from "./coding-runtime-resume.ts";
import { runSemanticLoop } from "./coding-runtime-semantic.ts";
import { runObserverHooks } from "./hook-runner.ts";
import {
	createProviderRuntime,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	providerCredentialOverride,
	resolveModel,
} from "./provider-runtime.ts";
import { PythonReadPool } from "./python-read-pool.ts";
import { loadHarnessResources } from "./resource-loader.ts";
import { ThreeXhaustState } from "./state.ts";

export { parseDurableCodingTaskCheckpoint } from "./coding-runtime-checkpoint.ts";
export type {
	CodingTaskEvent,
	CodingTaskImage,
	CodingTaskInput,
	CodingTaskPatchProposal,
	CodingTaskResourceOptions,
	CodingTaskResult,
	CodingTaskUsage,
	ConversationInput,
	ConversationResult,
	ResumeCodingTaskInput,
} from "./coding-runtime-contracts.ts";
export { executeReadPlanInvocations, type ReadPlanEventSink } from "./coding-runtime-evidence.ts";
export {
	configuredPythonConcurrency,
	createStreamingComplete,
	providerCacheSessionId,
	runConversation,
	semanticOperationTurnIds,
} from "./coding-runtime-provider.ts";

export async function runCodingTask(input: CodingTaskInput): Promise<CodingTaskResult> {
	const recovered = input.resumeCheckpoint ? parseDurableCodingTaskCheckpoint(input.resumeCheckpoint) : undefined;
	const projectRoot = recovered?.projectRoot ?? input.projectRoot;
	const objective = recovered?.objective ?? input.objective;
	const images = recovered?.images ?? input.images ?? [];
	const providerImages = images.map((image) => ({ type: "image" as const, ...image }));
	const provider = recovered?.provider ?? input.provider ?? DEFAULT_PROVIDER;
	const modelId = recovered?.model ?? input.model ?? DEFAULT_MODEL;
	const accountId = recovered?.accountId ?? input.accountId;
	const resources = input.resources?.enabled
		? loadHarnessResources({
				projectRoot,
				allowProjectHooks: input.resources.allowProjectHooks,
				...(input.resources.userRoot ? { userRoot: input.resources.userRoot } : {}),
				...(input.resources.builtinRoot ? { builtinRoot: input.resources.builtinRoot } : {}),
			})
		: {
				skills: [],
				hooks: [],
				entries: [],
				skillContext: "",
				resourceContextDigest: "sha256:disabled",
				digest: "sha256:disabled",
			};
	let hookChain = Promise.resolve<unknown>(undefined);
	const emit = (event: CodingTaskEvent): void => {
		input.onEvent?.(event);
		if (event.type !== "assistant.delta" && resources.hooks.length > 0) {
			hookChain = hookChain.then(() => runObserverHooks(resources.hooks, event, { cwd: projectRoot }));
		}
	};
	const models = createProviderRuntime(
		input.credential ? providerCredentialOverride(provider, input.credential) : undefined,
		accountId,
	);
	const needsProvider = !recovered || recovered.phase === "provider-ready" || recovered.phase === "followup-ready";
	if (needsProvider && !(await models.checkAuth(provider))) {
		throw new Error(`Provider is not authenticated: ${provider}`);
	}
	const model = resolveModel(models, provider, modelId);
	const evidence = prepareProjectEvidence(projectRoot, objective, resources.skillContext, recovered);
	const { stableContext, resumesApprovedPatch, durableDocuments, documents, snapshotRevision, snapshotSha256 } =
		evidence;
	const projectId = parseProjectId(`prj_${digest(projectRoot).slice(0, 24)}`);
	const sessionId = recovered?.sessionId ?? input.sessionId ?? `session_${randomUUID()}`;
	const providerSessionId = providerCacheSessionId(
		projectRoot,
		provider,
		modelId,
		objective,
		input.resources?.enabled ? resources.resourceContextDigest : undefined,
	);
	const requestId = recovered?.requestId ?? `req_${randomUUID()}`;
	const fingerprint = recovered?.fingerprint ?? digest(`${projectRoot}\0${objective}`);
	const generation = recovered?.generation ?? 1;
	const state = new ThreeXhaustState(input.statePath);
	const pythonConcurrency = configuredPythonConcurrency();
	const pythonPool = pythonConcurrency ? new PythonReadPool(pythonConcurrency) : undefined;
	const durableBase = {
		version: 1 as const,
		projectRoot,
		objective,
		...(images.length > 0 ? { images } : {}),
		approve: input.approve,
		provider,
		model: modelId,
		...(accountId ? { accountId } : {}),
		sessionId,
		requestId,
		fingerprint,
		snapshotSha256,
		resourceContextDigest: resources.resourceContextDigest,
		snapshotRevision,
		documents: durableDocuments,
		generation,
	};
	if (
		recovered?.resourceContextDigest !== undefined &&
		recovered.resourceContextDigest !== resources.resourceContextDigest &&
		["provider-settled", "followup-ready", "followup-settled"].includes(recovered.phase)
	) {
		throw new Error(
			"Global system prompt or resolved skills changed after semantic reasoning; start a new coding task",
		);
	}
	if (!recovered) {
		state.beginRun({
			projectId,
			projectPath: projectRoot,
			sessionId,
			requestId,
			fingerprint,
			payload: JSON.stringify({ objective }),
			checkpoint: JSON.stringify({ ...durableBase, phase: "provider-ready" }),
			generation,
		});
	}
	emit({
		type: "session.started",
		runtimeKind: "semantic-checkpoint",
		sessionId,
		provider,
		model: modelId,
		objective,
	});
	try {
		const semantic = await runSemanticLoop({
			models,
			model,
			emit,
			stableContext,
			...(resources.globalSystemPrompt ? { globalInstructions: resources.globalSystemPrompt.instructions } : {}),
			providerSessionId,
			...(input.signal ? { signal: input.signal } : {}),
			...(input.recordEffectBoundary ? { recordEffectBoundary: input.recordEffectBoundary } : {}),
			providerImages,
			objective,
			durableDocuments,
			projectRoot,
			documents,
			...(pythonPool ? { pythonPool } : {}),
			state,
			projectId,
			snapshotRevision,
			...(recovered ? { recovered } : {}),
			durableBase,
			generation,
			sessionId,
			requestId,
		});
		if (semantic.decision.kind !== "mutationProposal") {
			state.completeRun(sessionId, requestId, "completed");
			if (semantic.decision.kind === "completionSuggestion") {
				emit({ type: "assistant.message", text: semantic.decision.summary });
			} else if (semantic.decision.kind === "clarify") {
				emit({ type: "assistant.message", text: semantic.decision.question });
			} else {
				throw new Error(`Coding task ended without a patch proposal: ${semantic.decision.kind}`);
			}
			const result: CodingTaskResult = {
				sessionId,
				outcome: "completed",
				decision: semantic.decision.kind,
				usage: semantic.latestUsage,
			};
			emit({
				type: "session.completed",
				sessionId,
				outcome: result.outcome,
				decision: result.decision,
				usage: result.usage,
			});
			return result;
		}
		return await runPatchFlow({
			decision: semantic.decision,
			input,
			emit,
			state,
			sessionId,
			requestId,
			projectRoot,
			objective,
			snapshotRevision,
			documents,
			resumesApprovedPatch,
			...(recovered ? { recovered } : {}),
			durableBase,
			checkpointGeneration: semantic.checkpointGeneration,
			first: semantic.first,
			finalResult: semantic.finalResult,
			...(semantic.observationId ? { observationId: semantic.observationId } : {}),
			latestUsage: semantic.latestUsage,
		});
	} catch (error) {
		state.completeRun(sessionId, requestId, "failed");
		emit({
			type: "session.failed",
			sessionId,
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		await hookChain;
		pythonPool?.close();
		for (const phase of ["initial", "followup"] as const) {
			cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase));
			cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase, true));
		}
		state.close();
	}
}

export async function resumeCodingTask(input: ResumeCodingTaskInput): Promise<CodingTaskResult | undefined> {
	return resumeCodingTaskWith(input, runCodingTask);
}
