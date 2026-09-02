import { createHash, randomUUID } from "node:crypto";
import { eligibleModelAccounts, resolveSessionAccount } from "./account-selection.ts";
import { collectProviderConnections } from "./connections.ts";
import { consumeTuiPromotionAuthorization, type TuiAuxiliaryOverlay } from "./tui-auxiliary-overlay.ts";
import type { TuiCompletedAuxiliaryAnswer } from "./tui-auxiliary-types.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiPromotionPayload, TuiRequest, TuiRequestImage } from "./tui-operation-types.ts";

export interface TuiMainTurnAdmissionInput {
	readonly images?: readonly TuiRequestImage[];
	readonly objective: string;
}

export type TuiMainTurnAdmission =
	| {
			readonly provider: string;
			readonly status: "account-unavailable";
	  }
	| {
			readonly inserted: boolean;
			readonly request: TuiRequest;
			readonly status: "admitted";
	  };

export type TuiReviewedPromotionAdmission = TuiMainTurnAdmission | { readonly status: "review-unavailable" };

async function admitTuiTurn(
	core: TuiLiveCore,
	input: TuiMainTurnAdmissionInput,
	promotion?: TuiPromotionPayload,
): Promise<TuiMainTurnAdmission> {
	const { database, state } = core;
	const snapshot = {
		projectRoot: state.projectRoot,
		provider: state.provider,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
	};
	state.mainAdmissions += 1;
	try {
		const conversation = database.readTuiConversationHead(snapshot.projectRoot);
		const accounts = (await collectProviderConnections()).flatMap(({ accounts }) => accounts);
		const exclusions = database.listTuiAccountExclusions(snapshot.projectRoot);
		const pinnedAccountId = database.findTuiProviderAccount(snapshot.projectRoot, snapshot.provider);
		const account =
			eligibleModelAccounts(accounts, exclusions).find(
				(candidate) => candidate.providerId === snapshot.provider && candidate.id === pinnedAccountId,
			) ??
			resolveSessionAccount(
				accounts,
				exclusions,
				snapshot.provider,
				conversation.sessionId ?? `${snapshot.projectRoot}:${conversation.generation}`,
			);
		if (!account) return { provider: snapshot.provider, status: "account-unavailable" };
		if (account.id !== pinnedAccountId) {
			database.setTuiProviderAccount(snapshot.projectRoot, snapshot.provider, account.id);
		}
		const binding = {
			version: 1 as const,
			conversationGeneration: conversation.generation,
			sessionId: conversation.sessionId,
			provider: snapshot.provider,
			model: snapshot.model,
			accountId: account.id,
			thinkingLevel: snapshot.thinkingLevel,
		};
		const fingerprint = createHash("sha256")
			.update(`${snapshot.projectRoot}\0${binding.conversationGeneration}\0${binding.sessionId ?? ""}\0`)
			.update(`${binding.provider}\0${binding.model}\0${binding.accountId}\0${input.objective}`)
			.update("\0");
		for (const image of input.images ?? []) {
			fingerprint.update(image.mimeType).update("\0").update(image.data).update("\0");
		}
		if (promotion) {
			fingerprint.update(promotion.source.kind).update("\0").update(promotion.source.sourceId).update("\0");
		}
		const enqueued = database.enqueueTuiRequest({
			requestId: `tui_${randomUUID()}`,
			projectPath: snapshot.projectRoot,
			fingerprint: fingerprint.digest("hex"),
			objective: input.objective,
			...(input.images?.length ? { images: input.images } : {}),
			binding,
			...(promotion ? { promotion } : {}),
		});
		return { ...enqueued, status: "admitted" };
	} finally {
		state.mainAdmissions -= 1;
	}
}

export function admitTuiMainTurn(core: TuiLiveCore, input: TuiMainTurnAdmissionInput): Promise<TuiMainTurnAdmission> {
	return admitTuiTurn(core, input);
}

export function admitReviewedTuiPromotion(
	core: TuiLiveCore,
	overlay: TuiAuxiliaryOverlay,
	sources: readonly TuiCompletedAuxiliaryAnswer[],
): Promise<TuiReviewedPromotionAdmission> {
	const reviewed = consumeTuiPromotionAuthorization(overlay);
	const source = sources.find(
		(candidate) =>
			candidate.sourceId === reviewed?.sourceId &&
			candidate.question === reviewed.question &&
			candidate.answer === reviewed.answer,
	);
	if (!source) return Promise.resolve({ status: "review-unavailable" });
	const label = source.kind === "side" ? "Side Chat" : "BTW";
	const objective = `[Promoted from ${label}]\n\nQuestion:\n${source.question}\n\nAnswer:\n${source.answer}`;
	return admitTuiTurn(core, { objective }, { version: 1, source });
}
