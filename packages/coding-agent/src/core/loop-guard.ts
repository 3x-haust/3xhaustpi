/**
 * Detects a model repeating the same tool call with the same result.
 *
 * Problem: a model stuck on a failing command reruns it unchanged, for example `npm test` with
 * the same failure ten times, and pays for every round trip. Repeating a call is not wrong in
 * itself: `git status` after an edit returns a different result. Only an identical call with an
 * identical result carries no new information.
 *
 * Solution: remember a hash of (tool, arguments, result) for the most recent calls. When one
 * repeats `WARN_AT` times inside the window, the tool result gets a short note that tells the
 * model to change its approach.
 */

import { createHash } from "node:crypto";

const WINDOW = 12;
const WARN_AT = 3;

export class LoopGuard {
	private readonly recent: string[] = [];

	/** Record a finished call and return how often the same call and result occur in the window. */
	record(toolName: string, args: unknown, resultText: string): number {
		const key = createHash("sha256")
			.update(toolName)
			.update("\0")
			.update(JSON.stringify(args) ?? "")
			.update("\0")
			.update(resultText)
			.digest("hex");
		this.recent.push(key);
		if (this.recent.length > WINDOW) this.recent.shift();
		return this.recent.filter((entry) => entry === key).length;
	}
}

/** Note appended to a repeated result, or undefined while the repeat count is below the limit. */
export function formatLoopWarning(toolName: string, repeats: number): string | undefined {
	if (repeats < WARN_AT) return undefined;
	return `[Repeated call: this exact ${toolName} call returned the same result ${repeats} times recently. Repeating it will not change the outcome. Try a different approach, or stop and explain what is blocking you.]`;
}
