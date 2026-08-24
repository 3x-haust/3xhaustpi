import { afterEach, describe, expect, it, vi } from "vitest";
import { printCodingTaskEvent } from "../src/cli-output.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("non-interactive CLI output", () => {
	it.each([
		{
			name: "assistant messages",
			event: {
				type: "assistant.message",
				text: "before\u001b[31mred\u001b[0m\nlink\u001b]8;;https://evil.example\u0007label\u001b]8;;\u0007\u0000after",
			} as const,
			expected: "beforered\nlinklabelafter",
		},
		{
			name: "proposed patch diffs",
			event: {
				type: "patch.proposed",
				patchId: "patch-1",
				targetRevision: "revision-1",
				diff: "--- a/file\n+++ b/file\n+safe\u001b[2Jtext\u001b]0;owned\u0007\u0008\n+kept",
				files: ["file"],
			} as const,
			expected: "--- a/file\n+++ b/file\n+safetext\n+kept",
		},
	])("sanitizes CSI, OSC, and C0 controls in $name while preserving text and newlines", ({ event, expected }) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		printCodingTaskEvent(event);

		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(expected);
	});
});
