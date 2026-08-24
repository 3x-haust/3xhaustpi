import type { ThreeXhaustCommand } from "./args.ts";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { addMcpServer } from "./resource-hub.ts";
import { createSkillTemplate } from "./resource-loader.ts";

type ResourceCommand = Extract<
	ThreeXhaustCommand,
	{ readonly kind: "skill-create" | "mcp-add" | "mcp-tools" | "mcp-call" }
>;

export async function runResourceCommand(command: ResourceCommand, project: string): Promise<void> {
	if (command.kind === "skill-create") {
		const created = createSkillTemplate({ projectRoot: project, name: command.name, scope: "project" });
		console.log(`Created ${created.path}`);
		return;
	}
	if (command.kind === "mcp-add") {
		const path = addMcpServer({
			projectRoot: project,
			id: command.name,
			command: command.command,
			args: command.args,
			scope: "project",
		});
		console.log(`Added ${command.name} to ${path}`);
		return;
	}
	if (command.kind === "mcp-tools") {
		console.log(JSON.stringify(await listMcpTools({ projectRoot: project, server: command.server }), null, 2));
		return;
	}
	const args = command.jsonArgs ? JSON.parse(command.jsonArgs) : {};
	console.log(
		JSON.stringify(
			await callMcpTool({ projectRoot: project, server: command.server, tool: command.tool, arguments: args }),
			null,
			2,
		),
	);
}
