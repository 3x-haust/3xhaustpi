import { muted, stripAnsi } from "./tui-text.ts";
import { projectTranscriptCards } from "./tui-transcript-cards.ts";

export function fitTranscriptCards(
	entries: readonly string[],
	columns: number,
	budget: number,
	extraRowsByEntry: ReadonlyMap<number, readonly string[]> = new Map(),
): string[] {
	const visibleCards: string[][] = [];
	const cards = projectTranscriptCards(entries, columns, extraRowsByEntry);
	let remaining = Math.max(0, budget);
	for (let index = cards.length - 1; index >= 0 && remaining > 0; index -= 1) {
		const card = cards[index];
		if (!card) continue;
		if (card.length <= remaining) {
			visibleCards.unshift(card);
			remaining -= card.length;
			continue;
		}
		if (visibleCards.length === 0) {
			const cardHasTrailingGap = stripAnsi(card.at(-1) ?? "").trim().length === 0;
			const hasTrailingGap = cardHasTrailingGap && remaining > 2;
			const contentEnd = cardHasTrailingGap ? card.length - 1 : card.length;
			const anchorIndex = card.findIndex((line, candidateIndex) => {
				return candidateIndex < contentEnd && stripAnsi(line).trim().length > 0;
			});
			const resolvedAnchorIndex = anchorIndex === -1 ? 0 : anchorIndex;
			const anchor = card[resolvedAnchorIndex] ?? "";
			const body = card.slice(resolvedAnchorIndex + 1, contentEnd);
			const bodyBudget = Math.max(0, remaining - 1 - (hasTrailingGap ? 1 : 0));
			const omitted = body.length > bodyBudget;
			const omittedTailBudget = Math.max(0, remaining - 2);
			const visibleBody = omitted
				? remaining >= 2
					? [muted("  … omitted …"), ...(omittedTailBudget > 0 ? body.slice(-omittedTailBudget) : [])]
					: []
				: bodyBudget > 0
					? body.slice(-bodyBudget)
					: [];
			visibleCards.unshift([anchor, ...visibleBody, ...(hasTrailingGap && !omitted ? [""] : [])]);
			remaining = 0;
		}
		break;
	}
	return visibleCards.flat();
}
