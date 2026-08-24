import type { ThreeXhaustCommand } from "./args.ts";
import { runBenchmarkCommand } from "./cli-benchmark.ts";
import { printDoctorStatus } from "./cli-doctor.ts";
import { runNpmCommand, runUpdateCommand } from "./cli-maintenance.ts";
import { printAccounts, printExtensions, printHelp, printModels, printResources } from "./cli-output.ts";
import { canonicalProject } from "./cli-project.ts";
import { runResourceCommand } from "./cli-resource-commands.ts";
import { runCommand } from "./cli-run.ts";
import { PRODUCT_VERSION } from "./product-identity.ts";
import { loginProvider } from "./provider-runtime.ts";

export async function executeCliCommand(command: ThreeXhaustCommand): Promise<void> {
	if (command.kind === "help") return printHelp();
	if (command.kind === "version") return console.log(PRODUCT_VERSION);
	const project = canonicalProject(command.kind === "run" ? command.project : undefined);
	if (command.kind === "models") return printModels();
	if (command.kind === "extension-list") return printExtensions(project);
	if (command.kind === "resource-list") return printResources(project);
	if (command.kind === "accounts-list") return printAccounts();
	if (
		command.kind === "skill-create" ||
		command.kind === "mcp-add" ||
		command.kind === "mcp-tools" ||
		command.kind === "mcp-call"
	) {
		return runResourceCommand(command, project);
	}
	if (command.kind === "npm-login" || command.kind === "npm-publish") {
		return runNpmCommand(command, project);
	}
	if (command.kind === "benchmark") return runBenchmarkCommand(command);
	if (command.kind === "doctor") return printDoctorStatus(project);
	if (command.kind === "update") return runUpdateCommand();
	if (command.kind === "auth-login") return loginProvider(command.provider);
	return runCommand(command, project);
}
