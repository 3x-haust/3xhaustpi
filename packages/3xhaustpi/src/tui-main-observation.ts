import type { TuiMainObservation } from "./tui-auxiliary-types.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";

const MAIN_OBSERVATION_CHARACTERS = 24_000;

export function captureTuiMainObservation(core: TuiLiveCore, now = new Date().toISOString()): TuiMainObservation {
	const { state } = core;
	const head = core.database.readTuiConversationHead(state.projectRoot);
	return {
		version: 1,
		observedAt: now,
		sessionId: head.sessionId,
		activeObjective: state.activeOperation?.objective ?? null,
		phase: state.phase,
		activeCapabilities: [...state.activeCapabilities],
		activeWork: [...state.activeWork.values()].map(({ label }) => label),
		queuedObjectives: state.queuedRequests.map(({ objective }) => objective),
		transcriptTail: core.transcriptEntries.join("\n").slice(-MAIN_OBSERVATION_CHARACTERS),
	};
}
