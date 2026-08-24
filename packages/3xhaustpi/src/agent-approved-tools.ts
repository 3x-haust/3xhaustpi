import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createLocalBashOperations,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { approvedFileWrite } from "./agent-approved-file-write.ts";

export { approvedFileWrite } from "./agent-approved-file-write.ts";

const MAX_APPROVAL_COMMAND_CHARACTERS = 4_096;

export interface AgentToolApprovalRequest {
	readonly approvalId: string;
	readonly toolName: "bash" | "edit" | "write";
	readonly summary: string;
	readonly targetPath?: string;
	readonly beforeSha256?: string;
	readonly afterSha256?: string;
	readonly preview: string;
}

export type AgentToolApprovalCallback = (request: AgentToolApprovalRequest) => Promise<boolean>;

export async function approvedBashExecution<Result>(input: {
	readonly approvalId: string;
	readonly projectRoot: string;
	readonly command: string;
	readonly signal?: AbortSignal;
	readonly requestApproval: AgentToolApprovalCallback;
	readonly execute: () => Promise<Result>;
}): Promise<Result> {
	if (input.command.length > MAX_APPROVAL_COMMAND_CHARACTERS) {
		throw new Error(`Bash command exceeds ${MAX_APPROVAL_COMMAND_CHARACTERS} characters`);
	}
	const approved = await input.requestApproval({
		approvalId: input.approvalId,
		toolName: "bash",
		summary: `bash ${input.projectRoot}`,
		preview: input.command,
	});
	if (!approved) throw new Error("bash was rejected");
	input.signal?.throwIfAborted();
	return input.execute();
}

function approvalCallback(
	toolName: AgentToolApprovalRequest["toolName"],
	requestApproval: AgentToolApprovalCallback | undefined,
): AgentToolApprovalCallback {
	if (!requestApproval) throw new Error(`${toolName} requires host approval`);
	return requestApproval;
}

function lazySequentialTool<Definition extends object>(
	name: AgentToolApprovalRequest["toolName"],
	create: () => Definition,
): ToolDefinition {
	const exposed = { name, executionMode: "sequential" as const };
	let definition: Definition | undefined;
	return new Proxy(exposed as unknown as ToolDefinition, {
		get(target, property, receiver) {
			if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
			definition ??= create();
			return Reflect.get(definition, property, definition);
		},
	});
}

export function createApprovedAgentTools(input: {
	readonly projectRoot: string;
	readonly requestApproval?: AgentToolApprovalCallback;
	readonly signal?: AbortSignal;
}): ToolDefinition[] {
	return [
		lazySequentialTool("bash", () => {
			const localBashOperations = createLocalBashOperations();
			const bash = createBashToolDefinition(input.projectRoot, { operations: localBashOperations });
			return {
				...bash,
				executionMode: "sequential",
				execute: (...args: Parameters<typeof bash.execute>) =>
					approvedBashExecution({
						approvalId: args[0],
						projectRoot: input.projectRoot,
						command: args[1].command,
						signal: input.signal,
						requestApproval: approvalCallback("bash", input.requestApproval),
						execute: () => bash.execute(...args),
					}),
			};
		}),
		lazySequentialTool("edit", () => {
			const editCall = new AsyncLocalStorage<string>();
			const edit = createEditToolDefinition(input.projectRoot, {
				operations: {
					access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
					readFile,
					writeFile: (absolutePath, content) =>
						approvedFileWrite({
							approvalId: editCall.getStore() ?? "",
							toolName: "edit",
							projectRoot: input.projectRoot,
							absolutePath,
							content,
							signal: input.signal,
							requestApproval: approvalCallback("edit", input.requestApproval),
						}),
				},
			});
			return {
				...edit,
				executionMode: "sequential",
				execute: (...args: Parameters<typeof edit.execute>) => {
					approvalCallback("edit", input.requestApproval);
					return editCall.run(args[0], () => edit.execute(...args));
				},
			};
		}),
		lazySequentialTool("write", () => {
			const writeCall = new AsyncLocalStorage<string>();
			const write = createWriteToolDefinition(input.projectRoot, {
				operations: {
					mkdir: async () => {},
					writeFile: (absolutePath, content) =>
						approvedFileWrite({
							approvalId: writeCall.getStore() ?? "",
							toolName: "write",
							projectRoot: input.projectRoot,
							absolutePath,
							content,
							signal: input.signal,
							requestApproval: approvalCallback("write", input.requestApproval),
						}),
				},
			});
			return {
				...write,
				executionMode: "sequential",
				execute: (...args: Parameters<typeof write.execute>) => {
					approvalCallback("write", input.requestApproval);
					return writeCall.run(args[0], () => write.execute(...args));
				},
			};
		}),
	];
}
