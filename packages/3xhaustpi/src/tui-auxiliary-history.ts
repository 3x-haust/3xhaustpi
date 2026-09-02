import type {
	TuiAuxiliaryHistoryTurn,
	TuiAuxiliaryKind,
	TuiAuxiliaryTranscriptEntry,
	TuiCompletedAuxiliaryAnswer,
} from "./tui-auxiliary-types.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";

const AUXILIARY_CONTEXT_CHARACTERS = 24_000;

export function auxiliaryAnswers(
	core: TuiLiveCore,
	kind: TuiAuxiliaryKind,
	btwTurns: readonly TuiCompletedAuxiliaryAnswer[],
): TuiCompletedAuxiliaryAnswer[] {
	if (kind === "btw") return [...btwTurns];
	return core.database.sideChats.listCompleted(core.state.projectRoot).flatMap((turn) =>
		turn.answer
			? [
					{
						kind: "side" as const,
						sourceId: turn.turnId,
						question: turn.question,
						answer: turn.answer,
						completedAt: turn.updatedAt,
					},
				]
			: [],
	);
}

export function auxiliaryTranscript(answers: readonly TuiCompletedAuxiliaryAnswer[]): TuiAuxiliaryTranscriptEntry[] {
	return answers.flatMap((turn) => [
		{ role: "user" as const, text: turn.question },
		{ role: "assistant" as const, text: turn.answer, sourceId: turn.sourceId },
	]);
}

export function boundedAuxiliaryHistory(answers: readonly TuiCompletedAuxiliaryAnswer[]): TuiAuxiliaryHistoryTurn[] {
	const retained: TuiAuxiliaryHistoryTurn[] = [];
	let characters = 0;
	for (const turn of [...answers].reverse()) {
		const size = turn.question.length + turn.answer.length;
		if (retained.length > 0 && characters + size > AUXILIARY_CONTEXT_CHARACTERS) break;
		retained.push({ question: turn.question, answer: turn.answer });
		characters += size;
	}
	return retained.reverse();
}
