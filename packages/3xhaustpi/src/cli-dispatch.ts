import type { ThreeXhaustCommand } from "./args.ts";
import { runAccountCommand } from "./cli-account.ts";
import { runBenchmarkCommand } from "./cli-benchmark.ts";
import { printDoctorStatus } from "./cli-doctor.ts";
import { runSystemPromptInitCommand, runUpdateCommand } from "./cli-maintenance.ts";
import { printExtensions, printHelp, printModels, printResources } from "./cli-output.ts";
import { canonicalProject } from "./cli-project.ts";
import { runResourceCommand } from "./cli-resource-commands.ts";
import { runCommand } from "./cli-run.ts";
import { PRODUCT_VERSION } from "./product-identity.ts";

export async function executeCliCommand(command: ThreeXhaustCommand): Promise<void> {
	if (command.kind === "help") return printHelp();
	if (command.kind === "version") return console.log(PRODUCT_VERSION);
	const project = canonicalProject(command.kind === "run" ? command.project : undefined);
	if (command.kind === "models") return printModels();
	if (command.kind === "extension-list") return printExtensions(project);
	if (command.kind === "resource-list") return printResources(project);
	if (command.kind === "system-prompt-init") return runSystemPromptInitCommand();
	if (
		command.kind === "account-list" ||
		command.kind === "account-add" ||
		command.kind === "account-use" ||
		command.kind === "account-delete"
	) {
		return runAccountCommand(command);
	}
	if (
		command.kind === "skill-create" ||
		command.kind === "mcp-add" ||
		command.kind === "mcp-tools" ||
		command.kind === "mcp-call"
	) {
		return runResourceCommand(command, project);
	}
	if (command.kind === "benchmark") return runBenchmarkCommand(command);
	if (command.kind === "doctor") return printDoctorStatus(project);
	if (command.kind === "update") return runUpdateCommand();
	return runCommand(command, project);
}
