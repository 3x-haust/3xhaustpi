import { describe, expect, it } from "vitest";
import { formatCliError } from "../src/cli-error.ts";

describe("CLI error output", () => {
	it("strips terminal controls from dynamic prefixes and messages", () => {
		const output = formatCliError("Usage\u001b[31m error", "bad\u001b]52;c;Y2xpcGJvYXJk\u0007 path\u001b[2J", false);

		expect(output).toBe("Usage error: bad path");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u0007");
	});
});
