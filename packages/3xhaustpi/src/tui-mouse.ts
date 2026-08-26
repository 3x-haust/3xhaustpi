interface WritableTerminal {
	write(data: string): void;
}

export interface TuiMouseInput {
	readonly button: "left" | "other";
	readonly kind: "press" | "release";
	readonly column: number;
	readonly row: number;
}

const ENABLE_MOUSE_TRACKING = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_TRACKING = "\u001b[?1006l\u001b[?1000l";

export function parseTuiMouseInput(data: string): TuiMouseInput | undefined {
	const match = data.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/u);
	if (!match) return undefined;
	const buttonCode = Number.parseInt(match[1] ?? "", 10);
	const column = Number.parseInt(match[2] ?? "", 10);
	const row = Number.parseInt(match[3] ?? "", 10);
	if (!Number.isSafeInteger(buttonCode) || !Number.isSafeInteger(column) || !Number.isSafeInteger(row)) {
		return undefined;
	}
	if (column < 1 || row < 1) return undefined;
	return {
		button: buttonCode === 0 ? "left" : "other",
		kind: match[4] === "M" ? "press" : "release",
		column,
		row,
	};
}

export function enableTuiMouseTracking(terminal: WritableTerminal): () => void {
	terminal.write(ENABLE_MOUSE_TRACKING);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		terminal.write(DISABLE_MOUSE_TRACKING);
	};
}
