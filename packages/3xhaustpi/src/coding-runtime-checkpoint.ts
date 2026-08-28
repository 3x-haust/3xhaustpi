import { parseSemanticOutput } from "@3xhaust/semantic-contract";
import type { DurableCodingTaskCheckpoint } from "./coding-runtime-contracts.ts";
import { isImagePayloads } from "./image-payload.ts";
import type { ResumeCheckpoint } from "./state.ts";

export function parseDurableCodingTaskCheckpoint(
	checkpoint: ResumeCheckpoint,
	options: { readonly explicitRestart?: boolean } = {},
): DurableCodingTaskCheckpoint {
	const candidate = JSON.parse(checkpoint.payload) as Partial<DurableCodingTaskCheckpoint>;
	if (
		candidate.version !== 1 ||
		![
			"provider-ready",
			"provider-settled",
			"followup-ready",
			"followup-settled",
			"patch-approved",
			"patch-applied",
		].includes(candidate.phase ?? "") ||
		typeof candidate.projectRoot !== "string" ||
		typeof candidate.objective !== "string" ||
		typeof candidate.approve !== "boolean" ||
		typeof candidate.provider !== "string" ||
		typeof candidate.model !== "string" ||
		typeof candidate.sessionId !== "string" ||
		typeof candidate.requestId !== "string" ||
		typeof candidate.fingerprint !== "string" ||
		typeof candidate.snapshotSha256 !== "string" ||
		(candidate.resourceContextDigest !== undefined && typeof candidate.resourceContextDigest !== "string") ||
		(candidate.images !== undefined && !isImagePayloads(candidate.images)) ||
		!Number.isSafeInteger(candidate.generation)
	) {
		throw new Error("Durable coding checkpoint is invalid or unsupported");
	}
	if (
		candidate.sessionId !== checkpoint.sessionId ||
		candidate.requestId !== checkpoint.requestId ||
		candidate.fingerprint !== checkpoint.fingerprint ||
		candidate.projectRoot !== checkpoint.projectPath ||
		candidate.generation !== checkpoint.generation
	) {
		throw new Error("Durable coding checkpoint identity does not match the state database");
	}
	const legacyObservationId = (candidate as { readonly observationId?: unknown }).observationId;
	if (
		candidate.observationIds !== undefined &&
		(!Array.isArray(candidate.observationIds) ||
			candidate.observationIds.length === 0 ||
			candidate.observationIds.some((id) => typeof id !== "string" || !id))
	) {
		throw new Error("Follow-up checkpoint has invalid durable observations");
	}
	const observationIds =
		candidate.observationIds ??
		(typeof legacyObservationId === "string" && legacyObservationId ? [legacyObservationId] : undefined);
	const ready = candidate.phase === "provider-ready" || candidate.phase === "followup-ready";
	if (options.explicitRestart && checkpoint.outboxState !== "indeterminate") {
		throw new Error("Explicit restart requires an indeterminate provider receipt");
	}
	if (
		!options.explicitRestart &&
		((ready && checkpoint.outboxState !== "queued") || (!ready && checkpoint.outboxState !== "settled"))
	) {
		throw new Error(`Checkpoint provider state is ${checkpoint.outboxState}; automatic replay is blocked`);
	}
	const result = candidate.result
		? {
				output: parseSemanticOutput(candidate.result.output),
				...(candidate.result.responseId ? { responseId: candidate.result.responseId } : {}),
				usage: candidate.result.usage,
			}
		: undefined;
	if (candidate.phase === "provider-settled" && !result) {
		throw new Error("Settled provider checkpoint has no durable response");
	}
	const finalResult = candidate.finalResult
		? {
				output: parseSemanticOutput(candidate.finalResult.output),
				...(candidate.finalResult.responseId ? { responseId: candidate.finalResult.responseId } : {}),
				usage: candidate.finalResult.usage,
			}
		: undefined;
	if (
		(candidate.phase === "followup-ready" || candidate.phase === "followup-settled") &&
		(!result || !observationIds)
	) {
		throw new Error("Follow-up checkpoint is missing its durable observation");
	}
	if (candidate.phase === "followup-settled" && !finalResult) {
		throw new Error("Settled follow-up checkpoint has no durable response");
	}
	if (
		(candidate.phase === "patch-approved" || candidate.phase === "patch-applied") &&
		(!result ||
			typeof candidate.snapshotRevision !== "string" ||
			!Array.isArray(candidate.documents) ||
			candidate.documents.length === 0)
	) {
		throw new Error("Patch checkpoint is missing its durable project evidence");
	}
	return {
		...(candidate as DurableCodingTaskCheckpoint),
		...(result ? { result } : {}),
		...(finalResult ? { finalResult } : {}),
		...(observationIds ? { observationIds } : {}),
	};
}
