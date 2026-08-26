export type TuiCommandGroup = "conversation" | "work" | "environment" | "system";

export interface TuiPrimaryCommand {
	readonly name: string;
	readonly usage: string;
	readonly description: string;
	readonly group: TuiCommandGroup;
}

export const TUI_PRIMARY_COMMANDS = [
	{ name: "new", usage: "/new", description: "Start a new conversation", group: "conversation" },
	{ name: "resume", usage: "/resume", description: "Resume a saved conversation", group: "conversation" },
	{ name: "goal", usage: "/goal [text|done|clear]", description: "Manage the project goal", group: "conversation" },
	{ name: "btw", usage: "/btw <question>", description: "Ask a temporary side question", group: "conversation" },
	{ name: "compact", usage: "/compact [focus]", description: "Compress older context", group: "conversation" },
	{ name: "rewind", usage: "/rewind", description: "Branch from an earlier conversation turn", group: "work" },
	{ name: "review", usage: "/review [focus]", description: "Review current working changes", group: "work" },
	{ name: "status", usage: "/status", description: "Inspect session and work status", group: "work" },
	{ name: "model", usage: "/model", description: "Choose model and reasoning", group: "environment" },
	{ name: "project", usage: "/project", description: "Switch project", group: "environment" },
	{ name: "account", usage: "/account", description: "Manage accounts", group: "environment" },
	{ name: "skills", usage: "/skills", description: "Browse installed skills", group: "environment" },
	{ name: "settings", usage: "/settings", description: "Manage integrations and preferences", group: "environment" },
	{ name: "help", usage: "/help", description: "Show commands and keys", group: "system" },
	{ name: "exit", usage: "/exit", description: "Exit 3xhaustPi", group: "system" },
] as const satisfies readonly TuiPrimaryCommand[];
