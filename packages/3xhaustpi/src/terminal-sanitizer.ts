const ESCAPE = "\u001b";

export function sanitizeTerminalText(value: string): string {
	const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/\t/gu, "    ");
	const output: string[] = [];
	let index = 0;
	while (index < normalized.length) {
		const point = normalized.codePointAt(index);
		if (point === undefined) break;
		const character = String.fromCodePoint(point);
		if (character === ESCAPE) {
			const next = normalized[index + 1];
			if (next === "[") {
				index += 2;
				while (index < normalized.length) {
					const code = normalized.charCodeAt(index);
					index += 1;
					if (code >= 0x40 && code <= 0x7e) break;
				}
				continue;
			}
			if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
				const bellTerminated = next === "]";
				index += 2;
				while (index < normalized.length) {
					if (bellTerminated && normalized.charCodeAt(index) === 0x07) {
						index += 1;
						break;
					}
					if (normalized[index] === ESCAPE && normalized[index + 1] === "\\") {
						index += 2;
						break;
					}
					const part = normalized.codePointAt(index);
					index += part !== undefined && part > 0xffff ? 2 : 1;
				}
				continue;
			}
			index += next === undefined ? 1 : 2;
			continue;
		}
		const codePoint = character.codePointAt(0) ?? 0;
		if ((codePoint < 0x20 && character !== "\n") || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
			index += character.length;
			continue;
		}
		output.push(character);
		index += character.length;
	}
	return output.join("");
}
