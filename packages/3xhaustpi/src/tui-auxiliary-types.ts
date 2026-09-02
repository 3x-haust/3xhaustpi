export type TuiAuxiliaryKind = "side" | "btw";

export interface TuiAuxiliaryHistoryTurn {
	readonly question: string;
	readonly answer: string;
}

export interface TuiMainObservation {
	readonly version: 1;
	readonly observedAt: string;
	readonly sessionId: string | null;
	readonly activeObjective: string | null;
	readonly phase: "ready" | "running" | "awaiting-approval" | "success" | "error";
	readonly activeCapabilities: readonly string[];
	readonly activeWork: readonly string[];
	readonly queuedObjectives: readonly string[];
	readonly transcriptTail: string;
}

export interface TuiAuxiliaryRequestData {
	readonly kind: TuiAuxiliaryKind;
	readonly identity: string;
	readonly projectRoot: string;
	readonly question: string;
	readonly history: readonly TuiAuxiliaryHistoryTurn[];
	readonly observation?: TuiMainObservation;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface TuiCompletedAuxiliaryAnswer {
	readonly kind: TuiAuxiliaryKind;
	readonly sourceId: string;
	readonly question: string;
	readonly answer: string;
	readonly completedAt: string;
}

export interface TuiAuxiliaryTranscriptEntry {
	readonly role: "user" | "assistant";
	readonly text: string;
	readonly sourceId?: string;
}

export interface TuiReviewedAuxiliaryAnswer {
	readonly sourceId: string;
	readonly question: string;
	readonly answer: string;
}

export interface TuiAuxiliaryOverlayActions {
	readonly submit: (message: string) => void;
	readonly promote: () => void;
	readonly cancel: () => void;
	readonly close: () => void;
	readonly invalidate: () => void;
}
