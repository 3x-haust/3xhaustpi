import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

export const MAX_PROJECT_GOAL_CHARACTERS = 500;
export const MAX_PROJECT_GOAL_RAW_CODE_UNITS = 4_096;

export function normalizeProjectGoalText(value: string): string {
	const normalized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
	if ([...normalized].length > MAX_PROJECT_GOAL_CHARACTERS) {
		throw new RangeError(`Goal must be ${MAX_PROJECT_GOAL_CHARACTERS} characters or fewer.`);
	}
	return normalized;
}
