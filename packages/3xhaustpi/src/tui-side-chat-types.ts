export type TuiSideTurnStatus = "running" | "completed" | "failed" | "canceled";

export interface TuiAuxiliaryModelBinding {
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface TuiSideChat {
	readonly chatId: string;
	readonly projectPath: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TuiSideTurn {
	readonly turnId: string;
	readonly chatId: string;
	readonly sequence: number;
	readonly question: string;
	readonly answer: string | undefined;
	readonly status: TuiSideTurnStatus;
	readonly binding: TuiAuxiliaryModelBinding;
	readonly ownerId: string | undefined;
	readonly leaseEpoch: number;
	readonly leaseExpiresAt: string | undefined;
	readonly outcome: string | undefined;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface BeginTuiSideTurnInput {
	readonly projectPath: string;
	readonly turnId: string;
	readonly question: string;
	readonly binding: TuiAuxiliaryModelBinding;
	readonly ownerId: string;
	readonly leaseMs: number;
	readonly now?: string;
}

export interface TuiSideTurnLease {
	readonly ownerId: string;
	readonly leaseEpoch: number;
	readonly now?: string;
}

export interface RenewTuiSideTurnInput extends TuiSideTurnLease {
	readonly leaseMs: number;
}

export interface CompleteTuiSideTurnInput extends TuiSideTurnLease {
	readonly answer: string;
}

export interface TerminateTuiSideTurnInput extends TuiSideTurnLease {
	readonly status: "failed" | "canceled";
	readonly outcome: string;
}
