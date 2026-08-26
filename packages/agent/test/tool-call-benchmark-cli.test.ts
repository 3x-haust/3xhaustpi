import { describe, expect, it } from "vitest";
import { parseToolCallBenchmarkArgs, ToolCallBenchmarkCliError } from "../benchmark/tool-call-benchmark-cli.ts";

describe("tool-call benchmark CLI", () => {
	it("parses an explicit benchmark configuration", () => {
		// Given: all supported benchmark flags.
		const args = ["--check", "--batch-size", "32", "--warmups", "3", "--repetitions", "12"];

		// When: CLI arguments are parsed.
		const command = parseToolCallBenchmarkArgs(args);

		// Then: the typed run command carries each requested value.
		expect(command).toEqual({
			kind: "run",
			check: true,
			config: { batchSize: 32, warmups: 3, repetitions: 12 },
		});
	});

	it("returns help without constructing a benchmark run", () => {
		// Given: the standard help flag.
		const args = ["--help"];

		// When: CLI arguments are parsed.
		const command = parseToolCallBenchmarkArgs(args);

		// Then: help is selected as a distinct command.
		expect(command).toEqual({ kind: "help" });
	});

	it("rejects a non-positive workload size", () => {
		// Given: an invalid batch size at the CLI boundary.
		const args = ["--batch-size", "0"];

		// When: the arguments are parsed.
		const parse = () => parseToolCallBenchmarkArgs(args);

		// Then: the boundary returns a typed argument error.
		expect(parse).toThrow(ToolCallBenchmarkCliError);
	});
});
