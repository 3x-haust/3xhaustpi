import type { AgentProviderEffectBoundaryRequest, AgentToolApprovalRequest } from "./agent-runtime.ts";
import type { CodingTaskEvent, CodingTaskPatchProposal } from "./coding-runtime.ts";

export interface TuiRuntimeHooks {
	readonly onEvent: (event: CodingTaskEvent) => void;
	readonly requestApproval: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly recordEffect?: (effect: AgentProviderEffectBoundaryRequest) => Promise<void>;
	readonly requestToolApproval?: (request: AgentToolApprovalRequest) => Promise<boolean>;
	readonly signal: AbortSignal;
}

export type TuiRuntimeRequest =
	| {
			readonly mode: "run";
			readonly projectRoot: string;
			readonly objective: string;
			readonly provider?: string;
			readonly model?: string;
			readonly sessionId?: string;
			readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
			readonly allowProjectHooks?: boolean;
	  }
	| {
			readonly mode: "resume";
			readonly projectRoot: string;
			readonly sessionId?: string;
			readonly allowProjectHooks?: boolean;
	  };

export interface TuiRuntimeHostOptions {
	readonly workerPath?: string;
	readonly terminationGraceMs?: number;
}

export type RuntimeWorkerPayload =
	| { readonly type: "event"; readonly event: CodingTaskEvent }
	| { readonly type: "approval"; readonly proposal: CodingTaskPatchProposal }
	| { readonly type: "effect"; readonly effect: AgentProviderEffectBoundaryRequest }
	| { readonly type: "tool-approval"; readonly request: AgentToolApprovalRequest }
	| { readonly type: "result"; readonly available: boolean; readonly result?: unknown }
	| { readonly type: "error"; readonly message: string };

export type RuntimeWorkerMessage = RuntimeWorkerPayload & { readonly runId: string };

export type RuntimeRunParentMessage = (
	| { readonly type: "start"; readonly request: TuiRuntimeRequest }
	| { readonly type: "approval-decision"; readonly patchId: string; readonly approved: boolean }
	| { readonly type: "effect-ack"; readonly effectId: string }
	| { readonly type: "tool-approval-decision"; readonly approvalId: string; readonly approved: boolean }
	| { readonly type: "abort" }
) & { readonly runId: string };

export type RuntimeParentMessage = RuntimeRunParentMessage | { readonly type: "shutdown" };

export function createTuiRunRequest(input: {
	readonly projectRoot: string;
	readonly objective: string;
	readonly selectedModel: {
		readonly provider: string;
		readonly model: string;
		readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	};
	readonly sessionId?: string;
	readonly allowProjectHooks?: boolean;
}): TuiRuntimeRequest {
	return {
		mode: "run",
		projectRoot: input.projectRoot,
		objective: input.objective,
		provider: input.selectedModel.provider,
		model: input.selectedModel.model,
		...(input.selectedModel.thinkingLevel ? { thinkingLevel: input.selectedModel.thinkingLevel } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.allowProjectHooks ? { allowProjectHooks: true } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isRunId(value: unknown): value is string {
	return (
		typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
	);
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const tokenCount = (count: unknown) => count === null || isFiniteNumber(count);
	return (
		tokenCount(value.input) &&
		tokenCount(value.output) &&
		tokenCount(value.cacheRead) &&
		(value.cacheWrite === undefined || tokenCount(value.cacheWrite))
	);
}

function isPatchProposal(value: unknown): value is CodingTaskPatchProposal {
	return (
		isRecord(value) &&
		typeof value.patchId === "string" &&
		typeof value.targetRevision === "string" &&
		typeof value.diff === "string" &&
		isStringArray(value.files)
	);
}

function isCodingTaskEvent(value: unknown): value is CodingTaskEvent {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "session.started":
			return (
				(value.runtimeKind === "native-agent" || value.runtimeKind === "semantic-checkpoint") &&
				typeof value.sessionId === "string" &&
				typeof value.provider === "string" &&
				typeof value.model === "string" &&
				typeof value.objective === "string"
			);
		case "model.completed":
			return typeof value.responseId === "string" && isUsage(value.usage) && isFiniteNumber(value.durationMs);
		case "capability.started":
			return typeof value.capability === "string";
		case "capability.completed":
			return (
				typeof value.capability === "string" &&
				typeof value.success === "boolean" &&
				isFiniteNumber(value.durationMs) &&
				typeof value.summary === "string"
			);
		case "work.started":
			return (
				typeof value.workId === "string" &&
				isOptionalString(value.parentWorkId) &&
				(value.kind === "tool" || value.kind === "agent") &&
				typeof value.label === "string"
			);
		case "work.completed":
			return (
				typeof value.workId === "string" &&
				typeof value.success === "boolean" &&
				isFiniteNumber(value.durationMs) &&
				typeof value.summary === "string"
			);
		case "patch.proposed":
			return isPatchProposal(value);
		case "patch.decision":
			return typeof value.patchId === "string" && typeof value.approved === "boolean";
		case "diagnostics.completed":
			return (
				typeof value.success === "boolean" &&
				typeof value.command === "string" &&
				typeof value.output === "string" &&
				isFiniteNumber(value.durationMs)
			);
		case "assistant.delta":
		case "assistant.message":
			return typeof value.text === "string";
		case "session.completed":
			return (
				typeof value.sessionId === "string" &&
				(value.outcome === "completed" || value.outcome === "rejected") &&
				typeof value.decision === "string" &&
				isUsage(value.usage)
			);
		case "session.failed":
			return typeof value.sessionId === "string" && typeof value.message === "string";
		default:
			return false;
	}
}

function isEffect(value: unknown): value is AgentProviderEffectBoundaryRequest {
	return isRecord(value) && typeof value.effectId === "string" && value.kind === "provider";
}

function isToolApproval(value: unknown): value is AgentToolApprovalRequest {
	return (
		isRecord(value) &&
		typeof value.approvalId === "string" &&
		(value.toolName === "bash" || value.toolName === "edit" || value.toolName === "write") &&
		typeof value.summary === "string" &&
		isOptionalString(value.targetPath) &&
		isOptionalString(value.beforeSha256) &&
		isOptionalString(value.afterSha256) &&
		typeof value.preview === "string"
	);
}

export function isWorkerMessage(value: unknown): value is RuntimeWorkerMessage {
	if (!isRecord(value) || !isRunId(value.runId)) return false;
	switch (value.type) {
		case "event":
			return hasOnlyKeys(value, ["type", "runId", "event"]) && isCodingTaskEvent(value.event);
		case "approval":
			return hasOnlyKeys(value, ["type", "runId", "proposal"]) && isPatchProposal(value.proposal);
		case "effect":
			return hasOnlyKeys(value, ["type", "runId", "effect"]) && isEffect(value.effect);
		case "tool-approval":
			return hasOnlyKeys(value, ["type", "runId", "request"]) && isToolApproval(value.request);
		case "result":
			return (
				hasOnlyKeys(value, ["type", "runId", "available", "result"]) &&
				typeof value.available === "boolean" &&
				(value.available ? Object.hasOwn(value, "result") : value.result === undefined)
			);
		case "error":
			return hasOnlyKeys(value, ["type", "runId", "message"]) && typeof value.message === "string";
		default:
			return false;
	}
}

export function messageRunId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.runId === "string" ? value.runId : undefined;
}

export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
