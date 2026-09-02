import { isImagePayloads } from "./image-payload.ts";
import type { TuiRuntimeRequest } from "./tui-runtime-protocol.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasOptionalType(value: unknown, type: "string" | "boolean"): boolean {
	return value === undefined || typeof value === type;
}

function isThinkingLevel(value: unknown): boolean {
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isAuxiliaryHistory(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isRecord(entry) &&
				hasOnlyKeys(entry, ["question", "answer"]) &&
				typeof entry.question === "string" &&
				typeof entry.answer === "string",
		)
	);
}

function isMainObservation(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"version",
			"observedAt",
			"sessionId",
			"activeObjective",
			"phase",
			"activeCapabilities",
			"activeWork",
			"queuedObjectives",
			"transcriptTail",
		])
	) {
		return false;
	}
	return (
		value.version === 1 &&
		typeof value.observedAt === "string" &&
		(value.sessionId === null || typeof value.sessionId === "string") &&
		(value.activeObjective === null || typeof value.activeObjective === "string") &&
		["ready", "running", "awaiting-approval", "success", "error"].includes(String(value.phase)) &&
		isStringArray(value.activeCapabilities) &&
		isStringArray(value.activeWork) &&
		isStringArray(value.queuedObjectives) &&
		typeof value.transcriptTail === "string"
	);
}

export function isRuntimeRequest(value: unknown): value is TuiRuntimeRequest {
	if (!isRecord(value) || typeof value.projectRoot !== "string") return false;
	if (value.mode === "resume") {
		return (
			hasOnlyKeys(value, ["mode", "projectRoot", "sessionId", "allowProjectHooks"]) &&
			hasOptionalType(value.sessionId, "string") &&
			hasOptionalType(value.allowProjectHooks, "boolean")
		);
	}
	if (value.mode === "side-question") {
		return (
			hasOnlyKeys(value, [
				"mode",
				"projectRoot",
				"question",
				"context",
				"provider",
				"model",
				"accountId",
				"thinkingLevel",
			]) &&
			typeof value.question === "string" &&
			typeof value.context === "string" &&
			typeof value.provider === "string" &&
			typeof value.model === "string" &&
			hasOptionalType(value.accountId, "string") &&
			isThinkingLevel(value.thinkingLevel)
		);
	}
	if (value.mode === "auxiliary") {
		const valid =
			hasOnlyKeys(value, [
				"mode",
				"kind",
				"identity",
				"projectRoot",
				"question",
				"history",
				"observation",
				"provider",
				"model",
				"accountId",
				"thinkingLevel",
			]) &&
			(value.kind === "side" || value.kind === "btw") &&
			typeof value.identity === "string" &&
			typeof value.question === "string" &&
			isAuxiliaryHistory(value.history) &&
			typeof value.provider === "string" &&
			typeof value.model === "string" &&
			hasOptionalType(value.accountId, "string") &&
			isThinkingLevel(value.thinkingLevel);
		if (!valid) return false;
		return value.kind === "side" ? value.observation === undefined : isMainObservation(value.observation);
	}
	if (value.mode === "compact") {
		return (
			hasOnlyKeys(value, [
				"mode",
				"projectRoot",
				"sessionId",
				"instructions",
				"provider",
				"model",
				"accountId",
				"thinkingLevel",
			]) &&
			typeof value.sessionId === "string" &&
			hasOptionalType(value.instructions, "string") &&
			typeof value.provider === "string" &&
			typeof value.model === "string" &&
			hasOptionalType(value.accountId, "string") &&
			isThinkingLevel(value.thinkingLevel)
		);
	}
	if (value.mode === "cache-warm") {
		return (
			hasOnlyKeys(value, ["mode", "projectRoot", "sessionId", "provider", "model", "accountId", "thinkingLevel"]) &&
			typeof value.sessionId === "string" &&
			typeof value.provider === "string" &&
			typeof value.model === "string" &&
			hasOptionalType(value.accountId, "string") &&
			isThinkingLevel(value.thinkingLevel)
		);
	}
	if (value.mode !== "run" || typeof value.objective !== "string") return false;
	return (
		hasOnlyKeys(value, [
			"mode",
			"projectRoot",
			"objective",
			"provider",
			"model",
			"accountId",
			"images",
			"sessionId",
			"thinkingLevel",
			"allowProjectHooks",
		]) &&
		hasOptionalType(value.provider, "string") &&
		hasOptionalType(value.model, "string") &&
		hasOptionalType(value.accountId, "string") &&
		(value.images === undefined || isImagePayloads(value.images)) &&
		hasOptionalType(value.sessionId, "string") &&
		(value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel)) &&
		hasOptionalType(value.allowProjectHooks, "boolean")
	);
}
