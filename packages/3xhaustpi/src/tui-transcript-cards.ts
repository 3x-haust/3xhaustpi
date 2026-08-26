import {
	cellWidth,
	dim,
	emphasis,
	italic,
	muted,
	promptSurfaceLine,
	sanitizeTerminalText,
	splitGraphemes,
	stripAnsi,
	terminalStylesEnabled,
	text,
} from "./tui-text.ts";
import { formatTranscriptEntry } from "./tui-transcript-formatting.ts";

function wrapPlainLine(value: string, columns: number): string[] {
	const width = Math.max(1, columns);
	if (cellWidth(value) <= width) return [value];
	const lines: string[] = [];
	let line = "";
	let used = 0;
	const pushLine = () => {
		lines.push(line);
		line = "";
		used = 0;
	};
	for (const token of value.match(/\S+\s*|\s+/gu) ?? [value]) {
		const tokenWidth = cellWidth(token);
		if (tokenWidth <= width && used > 0 && used + tokenWidth > width) pushLine();
		if (tokenWidth <= width) {
			line += token;
			used += tokenWidth;
			continue;
		}
		for (const character of splitGraphemes(token)) {
			const characterWidth = cellWidth(character);
			if (used > 0 && used + characterWidth > width) pushLine();
			line += character;
			used += characterWidth;
		}
	}
	lines.push(line);
	return lines;
}

function messageCard(value: string, columns: number): string[] {
	const { role, label, content } = formatTranscriptEntry(value);
	const source = content || stripAnsi(sanitizeTerminalText(value));
	const physicalLines = source.split("\n");
	while (physicalLines.length > 1 && physicalLines[0]?.trim().length === 0) physicalLines.shift();
	while (physicalLines.length > 1 && physicalLines.at(-1)?.trim().length === 0) physicalLines.pop();
	const gutter = "  ";
	if (role === "you") {
		if (!terminalStylesEnabled()) {
			const contentWidth = Math.max(1, columns - cellWidth("> "));
			const rows = physicalLines
				.flatMap((physical) => wrapPlainLine(physical, contentWidth))
				.map((line) => `> ${line}`);
			return [...rows, ""];
		}
		const bodyIndent = "  ";
		const contentWidth = Math.max(1, columns - cellWidth(bodyIndent) * 2);
		const rows = physicalLines
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => promptSurfaceLine(`${bodyIndent}${line}`, columns));
		if (columns >= 40) return [promptSurfaceLine("", columns), ...rows, promptSurfaceLine("", columns), ""];
		return rows;
	}
	if (role === "threeXhaust") {
		const bodyIndent = gutter;
		const contentWidth = Math.max(1, Math.min(96, columns - cellWidth(bodyIndent)));
		const rows = physicalLines
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => text(`${bodyIndent}${line}`));
		return columns >= 40 ? ["", ...rows, ""] : rows;
	}
	if (role === "thought") {
		const contentWidth = Math.max(1, columns - cellWidth(gutter));
		return physicalLines
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => muted(italic(`${gutter}${line}`)));
	}
	if (role === "metrics") {
		const contentWidth = Math.max(1, columns - cellWidth(gutter));
		const rows = physicalLines
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => dim(`${gutter}${line}`));
		return [...rows, ""];
	}
	if (role === "system" || role === "notice") {
		const prefix = `${gutter}• `;
		const continuation = `${gutter}  `;
		const contentWidth = Math.max(1, columns - cellWidth(prefix));
		const rows = physicalLines.flatMap((physical) => wrapPlainLine(physical, contentWidth));
		return rows.map((line, index) => dim(`${index === 0 ? prefix : continuation}${line}`));
	}
	if (role === "agent" || role === "tool") {
		const prefix = gutter;
		const continuation = gutter;
		const contentWidth = Math.max(1, columns - cellWidth(gutter));
		const rows = physicalLines.flatMap((physical) => wrapPlainLine(physical, contentWidth));
		const rendered = rows.map((line, index) =>
			role === "agent"
				? muted(emphasis(`${index === 0 ? prefix : continuation}${line}`))
				: muted(`${index === 0 ? prefix : continuation}${line}`),
		);
		return [...rendered, ""];
	}
	const prefix = `${gutter}${label} ${dim("│")} `;
	const continuation = `${gutter}${" ".repeat(cellWidth(stripAnsi(label)))} ${dim("│")} `;
	const contentWidth = Math.max(1, columns - cellWidth(stripAnsi(prefix)));
	const rows = physicalLines.flatMap((physical) => wrapPlainLine(physical, contentWidth));
	return rows.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

export function projectTranscriptCards(
	entries: readonly string[],
	columns: number,
	extraRowsByEntry: ReadonlyMap<number, readonly string[]> = new Map(),
): string[][] {
	const templates = entries.map((entry) => formatTranscriptEntry(entry));
	const hasChat = templates.some(({ role }) => role === "you" || role === "threeXhaust");
	const cards: string[][] = [];
	let pendingActivity: string[][] = [];
	let activeAssistantCard: number | undefined;
	for (const [index, entry] of entries.entries()) {
		const template = templates[index];
		if (!template || (hasChat && template.role === "system")) continue;
		const card = messageCard(entry, columns);
		const extraRows = template.role === "you" ? extraRowsByEntry.get(index) : undefined;
		if (extraRows && extraRows.length > 0) {
			const trailingGap = card.at(-1) === "";
			if (trailingGap) card.pop();
			const insertionIndex =
				stripAnsi(card.at(-1) ?? "").trim().length === 0 ? Math.max(0, card.length - 1) : card.length;
			card.splice(insertionIndex, 0, ...extraRows);
			if (trailingGap) card.push("");
		}
		if (template.role === "agent" || template.role === "tool") {
			if (activeAssistantCard === undefined) {
				pendingActivity.push(card);
				continue;
			}
			const owner = cards[activeAssistantCard];
			if (!owner) continue;
			owner.push(...card);
			continue;
		}
		if (template.role === "thought" && pendingActivity.length > 0) {
			cards.push(...pendingActivity);
			pendingActivity = [];
		}
		if (template.role === "metrics" && activeAssistantCard !== undefined) {
			const owner = cards[activeAssistantCard];
			if (!owner) continue;
			if (owner.at(-1) === "") owner.pop();
			owner.push("", ...card);
			continue;
		}
		if (template.role === "you" && pendingActivity.length > 0) {
			cards.push(...pendingActivity);
			pendingActivity = [];
		}
		const pendingRows = template.role === "threeXhaust" ? pendingActivity.flat() : [];
		if (
			pendingRows.length > 0 &&
			stripAnsi(pendingRows.at(-1) ?? "").trim().length === 0 &&
			stripAnsi(card.at(0) ?? "").trim().length === 0
		) {
			pendingRows.pop();
		}
		const previousCard = cards.at(-1);
		const previousMargin = previousCard?.at(-1);
		if (
			pendingRows.length > 0 &&
			previousCard &&
			previousMargin !== undefined &&
			previousMargin !== "" &&
			stripAnsi(previousMargin).trim().length === 0
		) {
			previousCard[previousCard.length - 1] = "";
		}
		const renderedCard = pendingRows.length > 0 ? [...pendingRows, ...card] : card;
		if (template.role === "threeXhaust") pendingActivity = [];
		const previousGap = previousCard?.at(-1);
		const nextGap = renderedCard.at(0);
		if (
			previousCard &&
			previousGap !== undefined &&
			nextGap !== undefined &&
			stripAnsi(previousGap).trim().length === 0 &&
			stripAnsi(nextGap).trim().length === 0
		) {
			if (template.role !== "you") {
				if (nextGap === "") previousCard.pop();
				else renderedCard.shift();
			}
		}
		cards.push(renderedCard);
		activeAssistantCard = template.role === "threeXhaust" ? cards.length - 1 : undefined;
	}
	if (pendingActivity.length > 0) cards.push(...pendingActivity);
	return cards;
}
