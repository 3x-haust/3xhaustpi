import { pathToFileURL } from "node:url";
import { runToolCallBenchmark, type ToolCallBenchmarkConfig } from "./tool-call-benchmark.ts";

type ToolCallBenchmarkCommand =
	| { readonly kind: "help" }
	| { readonly kind: "run"; readonly check: boolean; readonly config: ToolCallBenchmarkConfig };

export class ToolCallBenchmarkCliError extends Error {
	readonly name = "ToolCallBenchmarkCliError";
}

const USAGE = `Usage: npm run benchmark:tools -- [options]

Options:
  --batch-size <n>    Tool calls per agent turn (default: 64)
  --warmups <n>       Unmeasured warmup batches per mode (default: 5)
  --repetitions <n>   Measured batches per mode (default: 30)
  --check             Exit non-zero when an acceptance gate fails
  --help              Show this help
`;

function positiveInteger(flag: string, value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new ToolCallBenchmarkCliError(`${flag} requires a positive integer`);
	}
	return parsed;
}

export function parseToolCallBenchmarkArgs(args: readonly string[]): ToolCallBenchmarkCommand {
	let batchSize = 64;
	let warmups = 5;
	let repetitions = 30;
	let check = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--help") return { kind: "help" };
		if (argument === "--check") {
			check = true;
			continue;
		}
		const value = args[index + 1];
		if (argument === "--batch-size") batchSize = positiveInteger(argument, value);
		else if (argument === "--warmups") warmups = positiveInteger(argument, value);
		else if (argument === "--repetitions") repetitions = positiveInteger(argument, value);
		else throw new ToolCallBenchmarkCliError(`Unknown option: ${argument ?? ""}`);
		index++;
	}
	return { kind: "run", check, config: { batchSize, warmups, repetitions } };
}

async function main(args: readonly string[]): Promise<void> {
	try {
		const command = parseToolCallBenchmarkArgs(args);
		if (command.kind === "help") {
			process.stdout.write(USAGE);
			return;
		}
		const report = await runToolCallBenchmark(command.config);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		if (command.check && !report.acceptance.passed) process.exitCode = 1;
	} catch (error) {
		if (!(error instanceof ToolCallBenchmarkCliError)) throw error;
		process.stderr.write(`${error.message}\n${USAGE}`);
		process.exitCode = 1;
	}
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main(process.argv.slice(2));
