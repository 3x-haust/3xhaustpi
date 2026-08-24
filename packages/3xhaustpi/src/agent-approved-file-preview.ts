const MAX_PREVIEW_LINES = 97;

type Change = { readonly kind: "equal" | "remove" | "add"; readonly line: string };

function backtrackChanges(
	trace: readonly Map<number, number>[],
	oldLines: readonly string[],
	newLines: readonly string[],
): Change[] {
	const changes: Change[] = [];
	let oldIndex = oldLines.length;
	let newIndex = newLines.length;
	for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
		const furthest = trace[distance];
		const diagonal = oldIndex - newIndex;
		const down =
			diagonal === -distance ||
			(diagonal !== distance && (furthest.get(diagonal - 1) ?? -1) < (furthest.get(diagonal + 1) ?? -1));
		const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
		const previousOld = furthest.get(previousDiagonal) ?? 0;
		const previousNew = previousOld - previousDiagonal;
		while (oldIndex > previousOld && newIndex > previousNew) {
			changes.push({ kind: "equal", line: oldLines[--oldIndex] });
			newIndex -= 1;
		}
		if (distance === 0) break;
		if (oldIndex === previousOld) changes.push({ kind: "add", line: newLines[--newIndex] });
		else changes.push({ kind: "remove", line: oldLines[--oldIndex] });
	}
	return changes.reverse();
}

function lineChanges(before: string, after: string): Change[] {
	const oldLines = before === "" ? [] : before.split("\n");
	const newLines = after === "" ? [] : after.split("\n");
	const trace: Map<number, number>[] = [];
	const furthest = new Map<number, number>([[1, 0]]);
	const maximumDistance = Math.min(oldLines.length + newLines.length, MAX_PREVIEW_LINES);
	for (let distance = 0; distance <= maximumDistance; distance += 1) {
		trace.push(new Map(furthest));
		for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
			const down =
				diagonal === -distance ||
				(diagonal !== distance && (furthest.get(diagonal - 1) ?? -1) < (furthest.get(diagonal + 1) ?? -1));
			let oldIndex = down ? (furthest.get(diagonal + 1) ?? 0) : (furthest.get(diagonal - 1) ?? 0) + 1;
			let newIndex = oldIndex - diagonal;
			while (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
				oldIndex += 1;
				newIndex += 1;
			}
			furthest.set(diagonal, oldIndex);
			if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
				return backtrackChanges(trace, oldLines, newLines);
			}
		}
	}
	throw new Error(`Mutation preview exceeds ${MAX_PREVIEW_LINES} review lines`);
}

export function mutationPreview(before: string, after: string, maximumCharacters: number): string {
	const changes = lineChanges(before, after);
	const output: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (let index = 0; index < changes.length; ) {
		if (changes[index].kind === "equal") {
			oldLine += 1;
			newLine += 1;
			index += 1;
			continue;
		}
		const startOld = oldLine;
		const startNew = newLine;
		const body: string[] = [];
		let removed = 0;
		let added = 0;
		while (index < changes.length && changes[index].kind !== "equal") {
			const change = changes[index++];
			if (change.kind === "remove") {
				body.push(`-${change.line}`);
				removed += 1;
				oldLine += 1;
			} else {
				body.push(`+${change.line}`);
				added += 1;
				newLine += 1;
			}
		}
		output.push(`@@ -${startOld},${removed} +${startNew},${added} @@`, ...body);
	}
	const preview = output.join("\n");
	if (preview.length > maximumCharacters || preview.split("\n").length > MAX_PREVIEW_LINES) {
		throw new Error("Mutation preview exceeds the review bound");
	}
	return preview;
}
