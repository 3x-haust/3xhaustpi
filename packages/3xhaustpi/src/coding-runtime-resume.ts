import { parseDurableCodingTaskCheckpoint } from "./coding-runtime-checkpoint.ts";
import type { CodingTaskInput, CodingTaskResult, ResumeCodingTaskInput } from "./coding-runtime-contracts.ts";
import { ThreeXhaustState } from "./state.ts";

export async function resumeCodingTaskWith(
	input: ResumeCodingTaskInput,
	runCodingTask: (input: CodingTaskInput) => Promise<CodingTaskResult>,
): Promise<CodingTaskResult | undefined> {
	const state = new ThreeXhaustState(input.statePath);
	let claim: ReturnType<ThreeXhaustState["claimExplicitResume"]>;
	try {
		state.recoverInterruptedRuns();
		claim = state.claimExplicitResume(input.sessionId, input.projectRoot);
	} finally {
		state.close();
	}
	if (!claim) return undefined;
	const checkpoint = claim.checkpoint;
	const restarted =
		claim.kind === "restart" ? parseDurableCodingTaskCheckpoint(checkpoint, { explicitRestart: true }) : undefined;
	return runCodingTask({
		projectRoot: restarted?.projectRoot ?? checkpoint.projectPath,
		objective: restarted?.objective ?? "",
		approve: input.approve,
		...(restarted ? { provider: restarted.provider, model: restarted.model } : {}),
		...(input.statePath ? { statePath: input.statePath } : {}),
		...(input.signal ? { signal: input.signal } : {}),
		...(input.onEvent ? { onEvent: input.onEvent } : {}),
		...(input.recordEffectBoundary ? { recordEffectBoundary: input.recordEffectBoundary } : {}),
		...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
		...(input.credential ? { credential: input.credential } : {}),
		...(input.strict ? { strict: true } : {}),
		...(input.preserveProviderSession ? { preserveProviderSession: true } : {}),
		...(input.resources ? { resources: input.resources } : {}),
		...(claim.kind === "checkpoint" ? { resumeCheckpoint: checkpoint } : {}),
	});
}
