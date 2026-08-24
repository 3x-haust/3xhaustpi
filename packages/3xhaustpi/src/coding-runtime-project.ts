import { compactContext } from "../../pi-adapter/src/index.ts";
import type { DurableCodingTaskCheckpoint } from "./coding-runtime-contracts.ts";
import { createProjectSnapshot } from "./project-snapshot.ts";

export function prepareProjectEvidence(
	projectRoot: string,
	objective: string,
	skillContext: string,
	recovered?: DurableCodingTaskCheckpoint,
) {
	const snapshot = createProjectSnapshot(projectRoot, objective);
	const skillContextBudget = Math.max(0, 18_000 - snapshot.stableContext.length - 2);
	const combinedStableContext =
		skillContextBudget > 0 && skillContext
			? `${snapshot.stableContext}\n\n${skillContext.slice(0, skillContextBudget)}`
			: snapshot.stableContext;
	// Compact instead of crashing when evidence plus skills exceed the prompt
	// budget; the deterministic cut keeps the provider cache prefix stable.
	const stableContext = compactContext(combinedStableContext, 4_500);
	const resumesApprovedPatch = recovered?.phase === "patch-approved" || recovered?.phase === "patch-applied";
	if (recovered && !resumesApprovedPatch && recovered.snapshotSha256 !== snapshot.sha256) {
		throw new Error("Project evidence changed after the checkpoint; resume blocked as stale");
	}
	const durableDocuments = resumesApprovedPatch ? recovered.documents! : snapshot.documents;
	return {
		stableContext,
		resumesApprovedPatch,
		durableDocuments,
		documents: new Map(durableDocuments.map((document) => [document.id, document])),
		snapshotRevision: recovered?.snapshotRevision ?? snapshot.revision,
		snapshotSha256: recovered?.snapshotSha256 ?? snapshot.sha256,
	};
}
