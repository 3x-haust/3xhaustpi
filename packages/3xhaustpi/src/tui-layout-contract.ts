import type { TuiDensityMode, TuiLayoutContract } from "./tui-contract.ts";
import { frameLine } from "./tui-text.ts";

function densityMode(columns: number): TuiDensityMode {
	if (columns < 40) return "degraded";
	if (columns < 56) return "minimal";
	if (columns < 80) return "compact";
	if (columns < 120) return "full";
	return "wide";
}

export function terminalBelowFloor(columns: number, rows: number): boolean {
	return columns < 20 || rows < 8;
}

export function terminalFloorLines(columns: number, rows: number): readonly string[] {
	const width = Math.max(1, Math.floor(columns));
	const height = Math.max(1, Math.floor(rows));
	const warning = width >= 28 ? "3xhaustPi · terminal too small" : width >= 19 ? "3xhaustPi too small" : "3xhaustPi";
	return [warning, "/exit"].slice(0, height).map((line) => frameLine(line, width));
}

export function layoutTuiFrame(
	columns: number,
	rows: number,
	options: { readonly autocompleteRows?: number } = {},
): TuiLayoutContract {
	const width = Math.max(1, Math.floor(columns));
	const height = Math.max(1, Math.floor(rows));
	const requested = Math.max(0, Math.floor(options.autocompleteRows ?? 0));
	const bounded = Math.min(requested, Math.floor(height * 0.4));
	const chromeRows = 6;
	const autocompleteRows = Math.min(bounded, Math.max(0, height - chromeRows - 1));
	const transcriptRows = Math.max(1, height - chromeRows - autocompleteRows);
	return {
		columns: width,
		rows: height,
		mode: densityMode(width),
		identityRows: 2,
		contextRows: 0,
		activityRows: 1,
		composerRows: 3,
		footerRows: 0,
		autocompleteRows,
		chromeRows,
		transcriptRows,
		totalRows: chromeRows + transcriptRows + autocompleteRows,
	};
}
