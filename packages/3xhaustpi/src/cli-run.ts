import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentToolApprovalRequest } from "./agent-approved-tools.ts";
import { AgentRuntimeHost, runAgentTask } from "./agent-runtime.ts";
import type { ThreeXhaustCommand } from "./args.ts";
import { printCodingTaskEvent } from "./cli-output.ts";
import { resumeCodingTask, runCodingTask } from "./coding-runtime.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";
import { sanitizeTerminalText } from "./terminal-sanitizer.ts";
import { runTui } from "./tui.ts";
import { formatToolApprovalReview } from "./tui-approval.ts";
import { collectWorkingTreeReviewEvidence } from "./working-tree-review.ts";

type RunCommand = Extract<ThreeXhaustCommand, { readonly kind: "run" }>;

export interface CliToolApprovalInput {
	readonly interactive: boolean;
	write(text: string): void;
	question(prompt: string): Promise<string>;
}

const terminalToolApprovalInput: CliToolApprovalInput = {
	interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
	write: (text) => console.log(text),
	question: (prompt) => {
		const readline = createInterface({ input: process.stdin, output: process.stdout });
		return new Promise((resolve) => {
			readline.question(prompt, (answer) => {
				readline.close();
				resolve(answer);
			});
		});
	},
};

export async function requestCliToolApproval(
	request: AgentToolApprovalRequest,
	input: CliToolApprovalInput = terminalToolApprovalInput,
): Promise<boolean> {
	const review = formatToolApprovalReview(request);
	input.write(
		sanitizeTerminalText(
			[
				`Tool approval  ${request.toolName}`,
				...review.lines,
				...(!input.interactive && review.reviewable
					? ["Tool rejected: explicit approval requires an interactive terminal."]
					: []),
			].join("\n"),
		),
	);
	if (!review.reviewable || !input.interactive) return false;
	const decision = (await input.question("Run this tool? [y/N] ")).trim().toLowerCase();
	return decision === "y" || decision === "yes";
}

async function runInteractive(command: RunCommand, project: string): Promise<void> {
	const runtimeHost = new AgentRuntimeHost();
	try {
		return await runTui({
			projectRoot: project,
			thinkingLevel: "medium",
			...(command.provider ? { provider: command.provider } : {}),
			...(command.model ? { model: command.model } : {}),
			compactConversation: (request) => runtimeHost.compactConversation(request),
			reviewWorkingTree: async (request) => {
				const before = await collectWorkingTreeReviewEvidence(request.projectRoot);
				const answer = await runtimeHost.runSideQuestion({
					...request,
					question: request.focus
						? `Review the working-tree evidence, focusing on: ${request.focus}`
						: "Review the working-tree evidence for defects, regressions, and missing tests.",
					context: before.text,
				});
				const after = await collectWorkingTreeReviewEvidence(request.projectRoot);
				return before.revision === after.revision
					? answer
					: `Working tree changed during review; findings may be stale.\n\n${answer}`;
			},
			runSideQuestion: (request) => runtimeHost.runSideQuestion(request),
			runAuxiliary: (request) => runtimeHost.runAuxiliary(request),
			runTask: async (projectRoot, objective, hooks, selectedModel) => {
				let effectAcknowledged = false;
				try {
					return await runtimeHost.run({
						projectRoot,
						objective,
						onEvent: hooks.onEvent,
						signal: hooks.signal,
						provider: selectedModel.provider,
						model: selectedModel.model,
						...(selectedModel.accountId ? { accountId: selectedModel.accountId } : {}),
						...(selectedModel.images?.length ? { images: selectedModel.images } : {}),
						...(selectedModel.sessionId ? { sessionId: selectedModel.sessionId } : {}),
						thinkingLevel: "medium",
						requestToolApproval: hooks.requestToolApproval,
						recordEffectBoundary: async (effect) => {
							await hooks.recordEffect(effect);
							effectAcknowledged = true;
						},
					});
				} catch (error) {
					if (selectedModel.sessionId || effectAcknowledged || hooks.signal.aborted) throw error;
					hooks.onEvent({
						type: "assistant.message",
						text: `Agent runtime unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`,
					});
					return runCodingTask({
						projectRoot,
						objective,
						approve: false,
						onEvent: hooks.onEvent,
						requestApproval: hooks.requestApproval,
						signal: hooks.signal,
						resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
						provider: selectedModel.provider,
						model: selectedModel.model,
						...(selectedModel.accountId ? { accountId: selectedModel.accountId } : {}),
						...(selectedModel.images?.length ? { images: selectedModel.images } : {}),
					});
				}
			},
			resumeTask: (projectRoot, sessionId, hooks) =>
				resumeCodingTask({
					approve: false,
					projectRoot,
					...(sessionId ? { sessionId } : {}),
					onEvent: hooks.onEvent,
					requestApproval: hooks.requestApproval,
					signal: hooks.signal,
					resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
				}),
		});
	} finally {
		await runtimeHost.close();
	}
}

export async function runCommand(command: RunCommand, project: string): Promise<void> {
	if (command.resume) {
		const resumed = await resumeCodingTask({
			approve: command.approve,
			...(command.project ? { projectRoot: project } : {}),
			onEvent: printCodingTaskEvent,
			resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
		});
		if (!resumed) throw new Error(`No durable ${PRODUCT_DISPLAY_NAME} checkpoint is available to resume.`);
		return;
	}
	const requestId = `req_${randomUUID()}`;
	const fingerprint = createHash("sha256")
		.update(`${project}\0${command.prompt ?? ""}`)
		.digest("hex")
		.slice(0, 16);
	if (!command.prompt && process.stdin.isTTY && process.stdout.isTTY) return runInteractive(command, project);
	if (!command.prompt) throw new Error(`Request ${requestId} (${fingerprint}) has no objective`);
	let effectAcknowledged = false;
	try {
		await runAgentTask({
			projectRoot: project,
			objective: command.prompt,
			onEvent: printCodingTaskEvent,
			thinkingLevel: "medium",
			requestToolApproval: requestCliToolApproval,
			recordEffectBoundary: async () => {
				effectAcknowledged = true;
			},
			...(command.provider ? { provider: command.provider } : {}),
			...(command.model ? { model: command.model } : {}),
		});
	} catch (error) {
		if (effectAcknowledged) throw error;
		console.error(
			sanitizeTerminalText(
				`Agent runtime unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		await runCodingTask({
			projectRoot: project,
			objective: command.prompt,
			approve: command.approve,
			onEvent: printCodingTaskEvent,
			resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
			...(command.provider ? { provider: command.provider } : {}),
			...(command.model ? { model: command.model } : {}),
		});
	}
}
