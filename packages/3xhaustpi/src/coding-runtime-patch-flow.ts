import type { RecipeDecision } from "../../core/src/index.ts";
import type {
	CodingTaskEvent,
	CodingTaskInput,
	CodingTaskResult,
	DurableCodingTaskCheckpoint,
	PersistedSemanticResult,
} from "./coding-runtime-contracts.ts";
import { runDiagnostics } from "./coding-runtime-diagnostics.ts";
import { approvalQuestion, createPatchProposal } from "./coding-runtime-patch.ts";
import { applyPreparedFiles, preparePatchedFiles } from "./coding-runtime-patch-apply.ts";
import type { ProjectDocument } from "./project-snapshot.ts";
import { createProjectSnapshot } from "./project-snapshot.ts";
import type { ThreeXhaustState } from "./state.ts";

type MutationDecision = Extract<RecipeDecision, { readonly kind: "mutationProposal" }>;
type DurableBase = Omit<DurableCodingTaskCheckpoint, "phase" | "result" | "finalResult" | "observationIds">;

export interface PatchFlowOptions {
	readonly decision: MutationDecision;
	readonly input: CodingTaskInput;
	readonly emit: (event: CodingTaskEvent) => void;
	readonly state: ThreeXhaustState;
	readonly sessionId: string;
	readonly requestId: string;
	readonly projectRoot: string;
	readonly objective: string;
	readonly snapshotRevision: string;
	readonly documents: ReadonlyMap<string, ProjectDocument>;
	readonly resumesApprovedPatch: boolean;
	readonly recovered?: DurableCodingTaskCheckpoint;
	readonly durableBase: DurableBase;
	readonly checkpointGeneration: number;
	readonly first: PersistedSemanticResult;
	readonly finalResult: PersistedSemanticResult;
	readonly observationId?: string;
	readonly latestUsage: CodingTaskResult["usage"];
}

export async function runPatchFlow(options: PatchFlowOptions): Promise<CodingTaskResult> {
	const {
		decision,
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
		recovered,
		durableBase,
		checkpointGeneration,
		first,
		finalResult,
		observationId,
		latestUsage,
	} = options;
	const patchId = `patch_${decision.proposal.proposalDigest.slice(-24)}`;
	const serializedProposal = JSON.stringify(decision.proposal);
	state.recordPatch(sessionId, patchId, snapshotRevision, "proposed", serializedProposal);
	const proposal = createPatchProposal(patchId, snapshotRevision, decision.proposal, documents);
	emit({ type: "patch.proposed", ...proposal });
	const approved =
		resumesApprovedPatch ||
		input.approve ||
		(input.requestApproval
			? await input.requestApproval(proposal)
			: Boolean(process.stdin.isTTY && (await approvalQuestion())));
	input.signal?.throwIfAborted();
	emit({ type: "patch.decision", patchId, approved });
	if (!approved) {
		state.recordPatch(sessionId, patchId, snapshotRevision, "rejected", serializedProposal);
		state.completeRun(sessionId, requestId, "completed");
		const result: CodingTaskResult = {
			sessionId,
			outcome: "rejected",
			decision: decision.kind,
			usage: latestUsage,
			patchId,
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
	if (!resumesApprovedPatch) {
		const current = createProjectSnapshot(projectRoot, objective);
		if (current.revision !== snapshotRevision) {
			state.recordPatch(sessionId, patchId, snapshotRevision, "conflict", serializedProposal);
			throw new Error("Project revision changed after proposal; patch blocked as stale");
		}
		state.recordPatch(sessionId, patchId, snapshotRevision, "approved", serializedProposal);
		state.updateCheckpoint(
			sessionId,
			checkpointGeneration,
			JSON.stringify({
				...durableBase,
				phase: "patch-approved",
				generation: checkpointGeneration,
				result: first,
				finalResult,
				...(observationId ? { observationId } : {}),
			} satisfies DurableCodingTaskCheckpoint),
		);
	} else {
		state.recordPatch(
			sessionId,
			patchId,
			snapshotRevision,
			recovered?.phase === "patch-applied" ? "applied" : "approved",
			serializedProposal,
		);
	}
	const prepared = preparePatchedFiles(projectRoot, decision.proposal, documents);
	const filesToApply = prepared.filter((file) => file.before !== file.after);
	if (resumesApprovedPatch && filesToApply.length === prepared.length) {
		const current = createProjectSnapshot(projectRoot, objective);
		if (current.revision !== snapshotRevision) {
			state.recordPatch(sessionId, patchId, snapshotRevision, "conflict", serializedProposal);
			throw new Error("Project revision changed after proposal; patch blocked as stale");
		}
	}
	if (recovered?.phase !== "patch-applied") {
		input.signal?.throwIfAborted();
		emit({ type: "capability.started", capability: "applyPatch" });
		const started = performance.now();
		applyPreparedFiles(projectRoot, filesToApply);
		emit({
			type: "capability.completed",
			capability: "applyPatch",
			success: true,
			durationMs: performance.now() - started,
			summary: `Applied ${filesToApply.length} file${filesToApply.length === 1 ? "" : "s"}`,
		});
		state.recordPatch(sessionId, patchId, snapshotRevision, "applied", serializedProposal);
		state.updateCheckpoint(
			sessionId,
			checkpointGeneration,
			JSON.stringify({
				...durableBase,
				phase: "patch-applied",
				generation: checkpointGeneration,
				result: first,
				finalResult,
				...(observationId ? { observationId } : {}),
			} satisfies DurableCodingTaskCheckpoint),
		);
	}
	emit({ type: "capability.started", capability: "getDiagnostics" });
	const diagnosticsStarted = performance.now();
	const diagnostics = runDiagnostics(projectRoot, input.strict === true);
	const diagnosticsDurationMs = performance.now() - diagnosticsStarted;
	emit({
		type: "capability.completed",
		capability: "getDiagnostics",
		success: diagnostics.success,
		durationMs: diagnosticsDurationMs,
		summary: diagnostics.success ? `${diagnostics.command} passed` : `${diagnostics.command} failed`,
	});
	emit({ type: "diagnostics.completed", ...diagnostics, durationMs: diagnosticsDurationMs });
	if (!diagnostics.success) throw new Error(`Diagnostics failed: ${diagnostics.command}`);
	state.completeRun(sessionId, requestId, "completed");
	const result: CodingTaskResult = {
		sessionId,
		outcome: "completed",
		decision: decision.kind,
		usage: latestUsage,
		patchId,
		diagnostics,
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
