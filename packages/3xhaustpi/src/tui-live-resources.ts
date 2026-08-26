import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { addMcpServer, loadMcpResources, renderResourceHub } from "./resource-hub.ts";
import { createSkillTemplate, loadHarnessResources } from "./resource-loader.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { SkillBrowserOverlay } from "./tui-skill-browser-overlay.ts";
import { dim, failure, muted, sanitizeTerminalText, success, text, warning } from "./tui-text.ts";

export function startSkillBrowser(core: TuiLiveCore, view: TuiLiveView): void {
	try {
		const skills = loadHarnessResources({ projectRoot: core.state.projectRoot }).skills;
		const columns = process.stdout.columns || 120;
		const rows = process.stdout.rows || 36;
		const overlayRows = () => Math.max(1, Math.floor((process.stdout.rows || 36) * 0.4));
		if (columns < 40 || rows < 10 || overlayRows() < 6) {
			view.appendText(text(`Installed skills · ${skills.length}`));
			for (const skill of skills) {
				view.appendText(
					`${text(sanitizeTerminalText(skill.name))}  ${muted(
						`${skill.scope} · ${sanitizeTerminalText(skill.description)}`,
					)}`,
				);
			}
			return;
		}
		let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
		const overlay = new SkillBrowserOverlay(skills, overlayRows, {
			close: () => handle?.hide(),
			invalidate: () => core.ui.requestRender(),
		});
		handle = core.ui.showOverlay(overlay, {
			width: Math.max(36, Math.min(76, columns - 4)),
			maxHeight: "40%",
			anchor: "top-center",
			margin: 2,
		});
	} catch (cause) {
		view.appendText(failure(cause instanceof Error ? cause.message : String(cause)));
	}
}

export function startResourcesCommand(core: TuiLiveCore, view: TuiLiveView): void {
	try {
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
	} catch (cause) {
		view.appendText(failure(cause instanceof Error ? cause.message : String(cause)));
	}
}

export async function handleSkillCommand(argument: string, core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	if (!argument || argument === "list") {
		startSkillBrowser(core, view);
		return;
	}
	const match = /^create\s+([a-z0-9][a-z0-9._-]{0,63})$/u.exec(argument);
	if (!match?.[1]) {
		view.appendText(warning("Usage: /skill [list | create <name>]"));
		return;
	}
	try {
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
