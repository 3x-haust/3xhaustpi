import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodingTaskEvent } from "./coding-runtime.ts";
import { collectConnections, renderConnections } from "./connections.ts";
import { resolveProjectDataDirectory, resolveUserDataDirectory } from "./identity.ts";
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from "./product-identity.ts";
import { providerStatuses } from "./provider-runtime.ts";
import { loadMcpResources, renderResourceHub } from "./resource-hub.ts";
import { loadHarnessResources } from "./resource-loader.ts";
import { sanitizeTerminalText } from "./tui-text.ts";

export function printCodingTaskEvent(event: CodingTaskEvent): void {
	if (event.type === "model.completed") {
		console.log(
			JSON.stringify({
				responseId: sanitizeTerminalText(event.responseId),
				usage: event.usage,
				durationMs: event.durationMs,
			}),
		);
		return;
	}
	if (event.type === "patch.proposed") {
		console.log(sanitizeTerminalText(event.diff));
		return;
	}
	if (event.type === "patch.decision" && !event.approved) {
		console.log(`Patch ${sanitizeTerminalText(event.patchId)} was not applied.`);
		return;
	}
	if (event.type === "assistant.message") {
		console.log(sanitizeTerminalText(event.text));
		return;
	}
	if (event.type === "diagnostics.completed") {
		console.log(
			JSON.stringify(
				{
					success: event.success,
					command: sanitizeTerminalText(event.command),
					output: sanitizeTerminalText(event.output),
					durationMs: event.durationMs,
				},
				null,
				2,
			),
		);
	}
}

export function printHelp(): void {
	console.log(`${PRODUCT_DISPLAY_NAME} ${PRODUCT_VERSION}

Usage:
  3xhaustpi
  3xhaustpi -p "로그인 오류를 조사하고 수정해"
  3xhaustpi --project ./my-project
  3xhaustpi --resume

Commands:
  auth login [provider]  Configure a provider connection
  models                 List supported providers and configuration state
  extension list         List discovered extension candidates
  resource list          Show Skills, MCP servers, and Hooks
  accounts               Show provider, Aside, and npm accounts
  npm login [account]    Run plain npm login through Aside
  npm publish [account]  Review account and publish package
  skill create <name>    Create an editable project skill
  mcp add <n> <cmd>      Add a project MCP server
  mcp tools <server>     List tools from a configured MCP server
  mcp call <srv> <tool>  Call a configured MCP tool with optional JSON args
  benchmark              Run the labeled local semantic-core benchmark
  benchmark --real       Run >=20 paired calls against an authenticated provider
  doctor                 Inspect install, runtime, and integration status
  update                 Update a global npm installation

Options:
  -p, --print <prompt>    Submit one non-interactive request
  --project <directory>  Select a project directory
  --resume               Resume a durable checkpoint
  --approve              Apply an exact patch proposal after printing its diff
  --provider <id>        Select an authenticated provider
  --model <id>           Select a provider model
  --allow-project-hooks  Enable declared project observer hooks
  -h, --help             Show help
  -v, --version          Show version`);
}

export async function providerRows(): Promise<
	readonly { readonly provider: string; readonly auth: string; readonly configured: boolean }[]
> {
	return providerStatuses();
}

export async function printModels(): Promise<void> {
	console.log("Provider        Auth                         State");
	for (const row of await providerRows()) {
		console.log(
			`${sanitizeTerminalText(row.provider).padEnd(15)} ${sanitizeTerminalText(row.auth).padEnd(28)} ${row.configured ? "configured" : "unconfigured"}`,
		);
	}
	console.log("\nDefault real-provider route: openai-codex/gpt-5.6-terra");
}

export function printExtensions(project: string): void {
	const directories = [
		join(resolveUserDataDirectory(), "extensions"),
		join(resolveProjectDataDirectory(project), "extensions"),
	];
	const entries = directories.flatMap((directory) =>
		existsSync(directory)
			? readdirSync(directory, { withFileTypes: true }).map((entry) => ({
					name: entry.name,
					scope: directory.startsWith(homedir()) ? "user" : "project",
					state: "disabled candidate",
				}))
			: [],
	);
	if (entries.length === 0) {
		console.log("No extension candidates found.");
		return;
	}
	for (const entry of entries) {
		console.log(`${entry.scope.padEnd(8)} ${entry.state.padEnd(20)} ${sanitizeTerminalText(entry.name)}`);
	}
}

export function printResources(project: string): void {
	const resources = loadHarnessResources({ projectRoot: project });
	console.log(
		sanitizeTerminalText(
			renderResourceHub({
				skills: resources.skills.map((skill) => ({
					id: skill.id,
					label: skill.name,
					scope: skill.scope,
					state: "enabled",
				})),
				mcpServers: loadMcpResources({ projectRoot: project }),
				hooks: resources.entries
					.filter((entry) => entry.kind === "hook")
					.map((entry) => ({
						id: entry.id,
						label: entry.reason ?? entry.sourcePath,
						scope: entry.scope,
						state: entry.state,
					})),
			}),
		),
	);
}

export async function printAccounts(): Promise<void> {
	console.log(sanitizeTerminalText(renderConnections(await collectConnections())));
}
