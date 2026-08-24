import { collectConnections, renderConnections, useAsideAccount } from "./connections.ts";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { addMcpServer, loadMcpResources, renderResourceHub } from "./resource-hub.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { dim, failure, muted, success, text, warning } from "./tui-text.ts";

export function startConnectionsCommand(argument: string, view: TuiLiveView): void {
	void (async () => {
		const use = /^use\s+(u\d+)$/u.exec(argument);
		if (use?.[1]) useAsideAccount(use[1]);
		const inventory = await collectConnections();
		for (const line of renderConnections(inventory).split("\n")) view.appendText(line || " ");
		view.appendText(dim("Use /accounts use <id> to select the default Aside account."));
	})().catch((cause) => view.appendText(failure(cause instanceof Error ? cause.message : String(cause))));
}

export function startResourcesCommand(core: TuiLiveCore, view: TuiLiveView): void {
	void (async () => {
		const { loadHarnessResources } = await import("./resource-loader.ts");
		const resources = loadHarnessResources({ projectRoot: core.state.projectRoot });
		const output = renderResourceHub({
			skills: resources.skills.map((skill) => ({
				id: skill.id,
				label: skill.name,
				scope: skill.scope,
				state: "enabled",
			})),
			mcpServers: loadMcpResources({ projectRoot: core.state.projectRoot }),
			hooks: resources.entries
				.filter((entry) => entry.kind === "hook")
				.map((entry) => ({
					id: entry.id,
					label: entry.reason ?? entry.sourcePath,
					scope: entry.scope,
					state: entry.state,
				})),
		});
		for (const line of output.split("\n")) view.appendText(line || " ");
		view.appendText(
			dim(
				"Add: /skill create <name>  ·  /mcp add <name> <command> [args...]  ·  /mcp tools <server>  ·  /mcp call <server> <tool> [json]",
			),
		);
	})().catch((cause) => view.appendText(failure(cause instanceof Error ? cause.message : String(cause))));
}

export async function handleSkillCommand(argument: string, core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	const match = /^create\s+([a-z0-9][a-z0-9._-]{0,63})$/u.exec(argument);
	if (!match?.[1]) {
		view.appendText(warning("Usage: /skill create <name>"));
		return;
	}
	try {
		const { createSkillTemplate } = await import("./resource-loader.ts");
		const created = createSkillTemplate({ projectRoot: core.state.projectRoot, name: match[1], scope: "project" });
		view.appendText(`${success("✓")} Created ${text(created.path)}`);
	} catch (cause) {
		view.appendText(failure(cause instanceof Error ? cause.message : String(cause)));
	}
}

export async function handleMcpCommand(argument: string, core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	const parts = argument.split(/\s+/u).filter(Boolean);
	try {
		if (parts[0] === "add" && parts[1] && parts[2]) {
			const path = addMcpServer({
				projectRoot: core.state.projectRoot,
				id: parts[1],
				command: parts[2],
				args: parts.slice(3),
				scope: "project",
			});
			view.appendText(`${success("✓")} Added ${text(parts[1])} to ${muted(path)}`);
			return;
		}
		if (parts[0] === "tools" && parts[1] && parts.length === 2) {
			const tools = await listMcpTools({ projectRoot: core.state.projectRoot, server: parts[1] });
			view.appendText(text(`MCP tools ${parts[1]}`));
			if (tools.length === 0) view.appendText(dim("No tools."));
			for (const tool of tools) view.appendText(`${text(tool.name)}  ${muted(tool.description ?? "")}`);
			return;
		}
		if (parts[0] === "call" && parts[1] && parts[2] && parts.length <= 4) {
			const result = await callMcpTool({
				projectRoot: core.state.projectRoot,
				server: parts[1],
				tool: parts[2],
				arguments: parts[3] ? JSON.parse(parts[3]) : {},
			});
			view.appendText(JSON.stringify(result, null, 2));
			return;
		}
		view.appendText(
			warning(
				"Usage: /mcp add <name> <command> [args...] | /mcp tools <server> | /mcp call <server> <tool> [json-args]",
			),
		);
	} catch (cause) {
		view.appendText(failure(cause instanceof Error ? cause.message : String(cause)));
	}
}
