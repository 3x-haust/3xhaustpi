export type ThreeXhaustCommand =
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "doctor" }
	| { readonly kind: "models" }
	| {
			readonly kind: "benchmark";
			readonly repetitions: number;
			readonly real: boolean;
			readonly provider?: string;
			readonly model?: string;
			readonly project?: string;
	  }
	| { readonly kind: "extension-list" }
	| { readonly kind: "resource-list" }
	| { readonly kind: "account-list" }
	| {
			readonly kind: "account-add";
			readonly provider?: string;
			readonly authType?: "oauth" | "api_key";
	  }
	| { readonly kind: "account-use"; readonly selector: string }
	| { readonly kind: "account-delete"; readonly selector: string }
	| { readonly kind: "skill-create"; readonly name: string }
	| {
			readonly kind: "mcp-add";
			readonly name: string;
			readonly command: string;
			readonly args: readonly string[];
	  }
	| { readonly kind: "mcp-tools"; readonly server: string }
	| { readonly kind: "mcp-call"; readonly server: string; readonly tool: string; readonly jsonArgs?: string }
	| { readonly kind: "update" }
	| {
			readonly kind: "run";
			readonly project?: string;
			readonly prompt?: string;
			readonly resume: boolean;
			readonly approve: boolean;
			readonly provider?: string;
			readonly model?: string;
			readonly allowProjectHooks?: boolean;
	  };

export class CliArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliArgumentError";
	}
}

function valueAfter(args: readonly string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new CliArgumentError(`${flag} requires a value`);
	return value;
}

export function parseCliArgs(args: readonly string[]): ThreeXhaustCommand {
	if (args.length === 0) return { kind: "run", resume: false, approve: false };
	if (args[0] === "help" || args.includes("--help") || args.includes("-h")) return { kind: "help" };
	if (args.includes("--version") || args.includes("-v")) return { kind: "version" };
	if (args[0] === "doctor") return { kind: "doctor" };
	if (args[0] === "models") return { kind: "models" };
	if (args[0] === "update") return { kind: "update" };
	if (args[0] === "account" && args.length === 1) return { kind: "account-list" };
	if (args[0] === "account") {
		if (args[1] === "add" && args.length <= 4) {
			const authType =
				args[3] === "oauth" ? "oauth" : args[3] === "api-key" || args[3] === "api_key" ? "api_key" : undefined;
			if (args[3] && !authType) throw new CliArgumentError("account add auth method must be oauth or api-key");
			return {
				kind: "account-add",
				...(args[2] ? { provider: args[2] } : {}),
				...(authType ? { authType } : {}),
			};
		}
		if (args[1] === "use" && args.length === 3 && args[2]) {
			return { kind: "account-use", selector: args[2] };
		}
		if (args[1] === "delete" && args.length === 3 && args[2]) {
			return { kind: "account-delete", selector: args[2] };
		}
		throw new CliArgumentError(
			'account supports "account", "account add [provider] [oauth|api-key]", "account use <id>", or "account delete <id>"',
		);
	}
	if (args[0] === "resource") {
		if (args[1] !== "list" || args.length !== 2) {
			throw new CliArgumentError('resource currently supports exactly "resource list"');
		}
		return { kind: "resource-list" };
	}
	if (args[0] === "skill") {
		if (args[1] !== "create" || args.length !== 3) {
			throw new CliArgumentError('skill currently supports "skill create <name>"');
		}
		return { kind: "skill-create", name: args[2]! };
	}
	if (args[0] === "mcp") {
		if (args[1] === "add") {
			if (args.length < 4) throw new CliArgumentError('mcp add requires "mcp add <name> <command> [args...]"');
			return { kind: "mcp-add", name: args[2]!, command: args[3]!, args: args.slice(4) };
		}
		if (args[1] === "tools") {
			if (args.length !== 3) throw new CliArgumentError('mcp tools requires "mcp tools <server>"');
			return { kind: "mcp-tools", server: args[2]! };
		}
		if (args[1] === "call") {
			if (args.length < 4 || args.length > 5) {
				throw new CliArgumentError('mcp call requires "mcp call <server> <tool> [json-args]"');
			}
			return { kind: "mcp-call", server: args[2]!, tool: args[3]!, ...(args[4] ? { jsonArgs: args[4] } : {}) };
		}
		throw new CliArgumentError('mcp supports "mcp add", "mcp tools", and "mcp call"');
	}
	if (args[0] === "npm") {
		throw new CliArgumentError(
			"Local npm login and publish are disabled; use the repository's reviewed Trusted Publishing workflow",
		);
	}
	if (args[0] === "extension") {
		if (args[1] !== "list" || args.length !== 2) {
			throw new CliArgumentError('extension currently supports exactly "extension list"');
		}
		return { kind: "extension-list" };
	}
	if (args[0] === "auth") {
		throw new CliArgumentError('Provider login moved to "account add [provider]"');
	}
	if (args[0] === "benchmark") {
		let repetitions: number | undefined;
		let real = false;
		let provider: string | undefined;
		let model: string | undefined;
		let project: string | undefined;
		for (let index = 1; index < args.length; index += 1) {
			const arg = args[index]!;
			if (arg === "--real") {
				real = true;
				continue;
			}
			if (!["--repetitions", "--provider", "--model", "--project"].includes(arg)) {
				throw new CliArgumentError(`Unknown benchmark option: ${arg}`);
			}
			const value = valueAfter(args, index, arg);
			if (arg === "--repetitions") {
				repetitions = Number(value);
				if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100_000) {
					throw new CliArgumentError("--repetitions must be an integer between 1 and 100000");
				}
			} else if (arg === "--provider") provider = value;
			else if (arg === "--model") model = value;
			else project = value;
			index += 1;
		}
		return {
			kind: "benchmark",
			repetitions: repetitions ?? (real ? 20 : 1_000),
			real,
			...(provider ? { provider } : {}),
			...(model ? { model } : {}),
			...(project ? { project } : {}),
		};
	}

	let project: string | undefined;
	let prompt: string | undefined;
	let resume = false;
	let approve = false;
	let provider: string | undefined;
	let model: string | undefined;
	let allowProjectHooks = false;
	const messages: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--project") {
			project = valueAfter(args, index, arg);
			index += 1;
		} else if (arg === "--resume") {
			resume = true;
		} else if (arg === "--approve") {
			approve = true;
		} else if (arg === "--provider") {
			provider = valueAfter(args, index, arg);
			index += 1;
		} else if (arg === "--model") {
			model = valueAfter(args, index, arg);
			index += 1;
		} else if (arg === "--allow-project-hooks") {
			allowProjectHooks = true;
		} else if (arg === "--print" || arg === "-p") {
			prompt = valueAfter(args, index, arg);
			index += 1;
		} else if (arg.startsWith("-")) {
			throw new CliArgumentError(`Unknown option: ${arg}`);
		} else {
			messages.push(arg);
		}
	}
	if (prompt && messages.length > 0) throw new CliArgumentError("Use either -p or a positional prompt, not both");
	if (!prompt && messages.length > 0) prompt = messages.join(" ");
	return {
		kind: "run",
		...(project ? { project } : {}),
		...(prompt ? { prompt } : {}),
		resume,
		approve,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(allowProjectHooks ? { allowProjectHooks: true } : {}),
	};
}
