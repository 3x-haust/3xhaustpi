import { describe, expect, it } from "vitest";
import { formatDoctorRow } from "../src/cli-doctor.ts";

describe("doctor terminal output", () => {
	it("removes terminal controls from every row field", () => {
		const row = formatDoctorRow(
			"project\u001b]52;c;bmFtZQ==\u0007",
			"verified\u001b[2J",
			"/tmp/safe\u001b]8;;https://evil.example\u0007path\u001b]8;;\u0007",
		);

		expect(row).not.toContain("\u001b]");
		expect(row).not.toContain("\u001b[");
		expect(row).toContain("project");
		expect(row).toContain("/tmp/safepath");
	});
});
