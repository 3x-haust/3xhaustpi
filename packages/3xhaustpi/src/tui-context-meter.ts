export function compactContextTokens(tokens: number): string {
	const bounded = Math.max(0, tokens);
	if (bounded < 1_000) return String(Math.round(bounded));
	const scaled = bounded / 1_000;
	return `${scaled >= 100 || Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}K`;
}

function contextPercent(used: number, limit: number): string {
	const percent = Math.max(0, (used / limit) * 100);
	if (percent > 0 && percent < 0.01) return `${percent.toPrecision(1)}%`;
	return `${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

export function contextUsageLabel(
	used: number | undefined,
	limit: number | undefined,
	style: "meter" | "feedback" | "ratio",
): string | undefined {
	if (limit === undefined || limit <= 0) {
		if (used === undefined) return undefined;
		const value = compactContextTokens(used);
		return style === "meter" ? `Ctx ${value}` : style === "feedback" ? `Context ${value}` : value;
	}
	const usage =
		used === undefined
			? `—/${compactContextTokens(limit)}`
			: `${compactContextTokens(used)}/${compactContextTokens(limit)}`;
	const ratio = used === undefined ? usage : `${usage} (${contextPercent(used, limit)})`;
	if (style === "ratio") return ratio;
	if (style === "feedback") return `Context ${ratio}`;
	return used === undefined ? `Ctx ${usage}` : `Ctx ${usage} · ${contextPercent(used, limit)}`;
}
