import { parseSemanticTurnRequest } from "@3xhaust/semantic-contract";
import type { Models } from "@earendil-works/pi-ai";
import { compileSemanticOutput, type RecipeDecision } from "../../core/src/index.ts";
import { createThreeXhaustPiAdapter } from "../../pi-adapter/src/index.ts";
import type {
	CodingTaskEvent,
	CodingTaskImage,
	CodingTaskUsage,
	DurableCodingTaskCheckpoint,
	PersistedSemanticResult,
} from "./coding-runtime-contracts.ts";
import { executeReadPlanInvocations } from "./coding-runtime-evidence.ts";
import {
	createStreamingComplete,
	digest,
	runProviderTurn,
	semanticOperationTurnIds,
	semanticUsage,
} from "./coding-runtime-provider.ts";
import type { ProjectDocument } from "./project-snapshot.ts";
import type { resolveModel } from "./provider-runtime.ts";
import type { PythonReadPool } from "./python-read-pool.ts";
import type { ThreeXhaustState } from "./state.ts";

type DurableBase = Omit<DurableCodingTaskCheckpoint, "phase" | "result" | "finalResult" | "observationIds">;

export interface SemanticLoopOptions {
	readonly models: Models;
	readonly model: ReturnType<typeof resolveModel>;
	readonly emit: (event: CodingTaskEvent) => void;
	readonly stableContext: string;
	readonly providerSessionId: string;
	readonly signal?: AbortSignal;
	readonly recordEffectBoundary?: (effect: { readonly effectId: string; readonly kind: "provider" }) => Promise<void>;
	readonly providerImages: readonly ({ readonly type: "image" } & CodingTaskImage)[];
	readonly objective: string;
	readonly durableDocuments: readonly ProjectDocument[];
	readonly projectRoot: string;
	readonly documents: ReadonlyMap<string, ProjectDocument>;
	readonly pythonPool?: PythonReadPool;
	readonly state: ThreeXhaustState;
	readonly projectId: Parameters<typeof compileSemanticOutput>[1]["projectId"];
	readonly snapshotRevision: string;
	readonly recovered?: DurableCodingTaskCheckpoint;
	readonly durableBase: DurableBase;
	readonly generation: number;
	readonly sessionId: string;
	readonly requestId: string;
}

export interface SemanticLoopResult {
	readonly decision: RecipeDecision;
	readonly first: PersistedSemanticResult;
	readonly finalResult: PersistedSemanticResult;
	readonly latestUsage: CodingTaskUsage;
	readonly observationId?: string;
	readonly checkpointGeneration: number;
}

export async function runSemanticLoop(options: SemanticLoopOptions): Promise<SemanticLoopResult> {
	const {
		models,
		emit,
		state,
		recovered,
		durableBase,
		generation,
		sessionId,
		requestId,
		objective,
		durableDocuments,
		snapshotRevision,
	} = options;
	const adapter = createThreeXhaustPiAdapter({ complete: createStreamingComplete(models, emit) });
	const semanticSession = adapter.open({
		connectionId: `connection_${durableBase.provider}`,
		model: options.model,
		sessionId: options.providerSessionId,
		cacheRetention: "long",
		cacheUsageSupport: { read: "reported", write: "reported" },
		stableContext: options.stableContext,
		maxTokens: 2_048,
	});
	let latestUsage: CodingTaskUsage = { input: null, output: null, cacheRead: null };
	let first: PersistedSemanticResult;
	if (recovered && recovered.phase !== "provider-ready") {
		first = recovered.result!;
		latestUsage = first.usage;
	} else {
		options.signal?.throwIfAborted();
		await options.recordEffectBoundary?.({ effectId: `provider_${sessionId}`, kind: "provider" });
		options.signal?.throwIfAborted();
		state.markProviderDispatching(requestId, generation);
		const started = performance.now();
		const live = await runProviderTurn(options.signal, (signal) =>
			semanticSession.submit(
				parseSemanticTurnRequest({
					protocolVersion: 2,
					mode: "prompt",
					objective,
					disclosed: {
						selectionIds: [],
						documentIds: durableDocuments.map((document) => document.id),
						observationIds: [],
					},
				}),
				signal,
				options.providerImages,
			),
		);
		latestUsage = semanticUsage(live);
		emit({
			type: "model.completed",
			responseId: live.responseId ?? `response_${requestId}`,
			usage: latestUsage,
			durationMs: performance.now() - started,
		});
		first = { output: live.output, ...(live.responseId ? { responseId: live.responseId } : {}), usage: latestUsage };
		state.settleProviderAndCheckpoint(
			requestId,
			sessionId,
			generation,
			live.responseId,
			JSON.stringify({ ...durableBase, phase: "provider-settled", result: first }),
		);
	}
	const turnIds = semanticOperationTurnIds(options.projectRoot, objective, snapshotRevision);
	let decision = await compileSemanticOutput(first.output, {
		projectId: options.projectId,
		turnId: turnIds.initial,
		projectRevision: snapshotRevision,
		observationDigests: [],
	});
	let finalResult = first;
	const observationIds: string[] = [...(recovered?.observationIds ?? [])];
	let observationId = observationIds[0];
	let checkpointGeneration = recovered?.generation ?? generation;
	if (decision.kind === "readPlan" && decision.invocations.length >= 1) {
		const invocations = decision.invocations.slice(0, 4);
		const exactTarget =
			invocations.length === 1 && typeof invocations[0]!.input.query === "string"
				? JSON.stringify(invocations[0]!.input.query)
				: "the disclosed bounded evidence";
		if (recovered?.finalResult) {
			finalResult = recovered.finalResult;
			latestUsage = finalResult.usage;
		} else {
			const followupGeneration = recovered?.phase === "followup-ready" ? recovered.generation : generation + 1;
			checkpointGeneration = followupGeneration;
			if (!observationId) {
				const observations = await executeReadPlanInvocations(invocations, {
					projectRoot: options.projectRoot,
					documents: options.documents,
					pythonPool: options.pythonPool,
					onStarted: (capability) => emit({ type: "capability.started", capability }),
					onCompleted: emit,
				});
				observationIds.push(...observations.map((observation) => observation.observationId));
				observationId = observationIds[0];
				for (const observation of observations) {
					state.recordObservation(sessionId, observation.observationId, JSON.stringify(observation));
				}
				state.prepareProviderDispatch(
					requestId,
					sessionId,
					followupGeneration,
					digest(`${objective}\0${observationId}`),
					JSON.stringify({
						...durableBase,
						phase: "followup-ready",
						generation: followupGeneration,
						result: first,
						observationIds,
					}),
				);
			}
			options.signal?.throwIfAborted();
			await options.recordEffectBoundary?.({ effectId: `provider_${sessionId}`, kind: "provider" });
			options.signal?.throwIfAborted();
			state.markProviderDispatching(requestId, followupGeneration);
			const started = performance.now();
			const live = await runProviderTurn(options.signal, (signal) =>
				semanticSession.submit(
					parseSemanticTurnRequest({
						protocolVersion: 2,
						mode: "followUp",
						objective: `Successful observation: ${exactTarget}.`,
						disclosed: {
							selectionIds: [],
							documentIds: durableDocuments.map((document) => document.id),
							observationIds,
						},
					}),
					signal,
				),
			);
			latestUsage = semanticUsage(live);
			emit({
				type: "model.completed",
				responseId: live.responseId ?? `response_${requestId}_followup`,
				usage: latestUsage,
				durationMs: performance.now() - started,
			});
			finalResult = {
				output: live.output,
				...(live.responseId ? { responseId: live.responseId } : {}),
				usage: latestUsage,
			};
			state.settleProviderAndCheckpoint(
				requestId,
				sessionId,
				followupGeneration,
				live.responseId,
				JSON.stringify({
					...durableBase,
					phase: "followup-settled",
					generation: followupGeneration,
					result: first,
					finalResult,
					observationIds,
				}),
			);
		}
		decision = await compileSemanticOutput(finalResult.output, {
			projectId: options.projectId,
			turnId: turnIds.followup,
			projectRevision: snapshotRevision,
			observationDigests: [...observationIds],
		});
	}
	await semanticSession.close();
	return {
		decision,
		first,
		finalResult,
		latestUsage,
		...(observationId ? { observationId } : {}),
		checkpointGeneration,
	};
}
