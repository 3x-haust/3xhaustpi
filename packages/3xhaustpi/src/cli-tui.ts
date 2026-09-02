import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CliArgumentError, parseCliArgs } from "./args.ts";
import type { CacheWarmResult } from "./cache-warm-controller.ts";
import { formatCliError } from "./cli-error.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";
import { AUTH_PATH } from "./provider-runtime.ts";
import { runTui } from "./tui.ts";
import type { TuiCompactionResult } from "./tui-contract.ts";
import { createTuiRunRequest, type TuiRuntimeHooks, TuiRuntimeHost } from "./tui-runtime-client.ts";
import { collectWorkingTreeReviewEvidence } from "./working-tree-review.ts";

function canonicalProject(input: string | undefined): string {
	const target = resolve(input ?? process.cwd());
	if (!existsSync(target)) throw new Error(`Project directory does not exist: ${target}`);
	if (!statSync(target).isDirectory()) throw new Error(`Project path is not a directory: ${target}`);
	return realpathSync(target);
}

function providerConfigured(provider: string): boolean {
	if (!existsSync(AUTH_PATH)) return false;
	try {
		const parsed = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && provider in parsed;
	} catch {
		return false;
	}
}

function quickHooks(signal: AbortSignal): TuiRuntimeHooks {
	return {
		onEvent: () => {},
		requestApproval: async () => false,
		signal,
	};
}

function runtimeText(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("TUI runtime returned an invalid text result");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteField(record: Record<string, unknown>, field: string, scope: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`TUI runtime ${scope} is missing ${field}`);
	}
	return value;
}

function runtimeCacheWarmResult(value: unknown): CacheWarmResult {
	if (!isRecord(value)) {
		throw new TypeError("TUI runtime returned an invalid cache-warm result");
	}
	const usage = value.usage;
	if (!isRecord(usage)) {
		throw new TypeError("TUI runtime returned invalid cache-warm usage");
	}
	const durationMs = finiteField(value, "durationMs", "cache-warm result");
	const contextTokens = finiteField(value, "contextTokens", "cache-warm result");
	const input = finiteField(usage, "input", "cache-warm usage");
	const output = finiteField(usage, "output", "cache-warm usage");
	const cacheRead = finiteField(usage, "cacheRead", "cache-warm usage");
	const cacheWrite = finiteField(usage, "cacheWrite", "cache-warm usage");
	const estimatedSavingsUsd =
		typeof value.estimatedSavingsUsd === "number" && Number.isFinite(value.estimatedSavingsUsd)
			? value.estimatedSavingsUsd
			: undefined;
	return {
		durationMs,
		contextTokens,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
		},
		...(estimatedSavingsUsd !== undefined ? { estimatedSavingsUsd } : {}),
	};
}

function runtimeCompactionResult(value: unknown): TuiCompactionResult {
	if (!isRecord(value)) throw new TypeError("TUI runtime returned an invalid compaction result");
	const tokensBefore = finiteField(value, "tokensBefore", "compaction result");
	const estimatedTokensAfter =
		typeof value.estimatedTokensAfter === "number" && Number.isFinite(value.estimatedTokensAfter)
			? value.estimatedTokensAfter
			: undefined;
	return {
		tokensBefore,
		...(estimatedTokensAfter !== undefined ? { estimatedTokensAfter } : {}),
	};
}

try {
	const command = parseCliArgs(process.argv.slice(2));
	if (command.kind !== "run" || command.prompt || command.resume) {
		throw new Error("cli-tui only supports a fresh interactive TUI run");
	}
	const projectRoot = canonicalProject(command.project);
	const provider = command.provider ?? "openai-codex";
	const model = command.model ?? "gpt-5.6-terra";
	const runtimeHost = new TuiRuntimeHost();
	const quickRuntimeHost = new TuiRuntimeHost();
	const cacheWarmRuntimeHost = new TuiRuntimeHost();
	try {
		await runTui({
			projectRoot,
			provider,
			model,
			providerConfigured: providerConfigured(provider),
			compactConversation: (request) =>
				runtimeHost
					.run(
						{
							mode: "compact",
							projectRoot: request.projectRoot,
							sessionId: request.sessionId,
							...(request.instructions ? { instructions: request.instructions } : {}),
							provider: request.provider,
							model: request.model,
							...(request.accountId ? { accountId: request.accountId } : {}),
							thinkingLevel: request.thinkingLevel,
						},
						quickHooks(request.signal),
					)
					.then(runtimeCompactionResult),
			reviewWorkingTree: async (request) => {
				const before = await collectWorkingTreeReviewEvidence(request.projectRoot);
				const answer = runtimeText(
					await quickRuntimeHost.run(
						{
							mode: "side-question",
							projectRoot: request.projectRoot,
							question: request.focus
								? `Review the working-tree evidence, focusing on: ${request.focus}`
								: "Review the working-tree evidence for defects, regressions, and missing tests.",
							context: before.text,
							provider: request.provider,
							model: request.model,
							...(request.accountId ? { accountId: request.accountId } : {}),
							thinkingLevel: request.thinkingLevel,
						},
						quickHooks(request.signal),
					),
				);
				const after = await collectWorkingTreeReviewEvidence(request.projectRoot);
				return before.revision === after.revision
					? answer
					: `Working tree changed during review; findings may be stale.\n\n${answer}`;
			},
			runSideQuestion: async (request) =>
				runtimeText(
					await quickRuntimeHost.run(
						{
							mode: "side-question",
							projectRoot: request.projectRoot,
							question: request.question,
							context: request.context,
							provider: request.provider,
							model: request.model,
							...(request.accountId ? { accountId: request.accountId } : {}),
							thinkingLevel: request.thinkingLevel,
						},
						quickHooks(request.signal),
					),
				),
			runAuxiliary: async (request) =>
				runtimeText(
					await quickRuntimeHost.run(
						{
							mode: "auxiliary",
							kind: request.kind,
							identity: request.identity,
							projectRoot: request.projectRoot,
							question: request.question,
							history: request.history,
							...(request.observation ? { observation: request.observation } : {}),
							provider: request.provider,
							model: request.model,
							...(request.accountId ? { accountId: request.accountId } : {}),
							thinkingLevel: request.thinkingLevel,
						},
						quickHooks(request.signal),
					),
				),
			warmCache: async (request) =>
				runtimeCacheWarmResult(
					await cacheWarmRuntimeHost.run(
						{
							mode: "cache-warm",
							projectRoot: request.projectRoot,
							sessionId: request.sessionId,
							provider: request.provider,
							model: request.model,
							...(request.accountId ? { accountId: request.accountId } : {}),
							thinkingLevel: request.thinkingLevel,
						},
						quickHooks(request.signal),
					),
				),
			runTask: (activeProjectRoot, objective, hooks, selectedModel) =>
				runtimeHost.run(
					createTuiRunRequest({
						projectRoot: activeProjectRoot,
						objective,
						selectedModel,
						...(selectedModel.sessionId ? { sessionId: selectedModel.sessionId } : {}),
						...(command.allowProjectHooks ? { allowProjectHooks: true } : {}),
					}),
					hooks,
				),
			resumeTask: (activeProjectRoot, sessionId, hooks) =>
				runtimeHost.run(
					{
						mode: "resume",
						projectRoot: activeProjectRoot,
						...(sessionId ? { sessionId } : {}),
						...(command.allowProjectHooks ? { allowProjectHooks: true } : {}),
					},
					hooks,
				),
		});
	} finally {
		await Promise.all([runtimeHost.close(), quickRuntimeHost.close(), cacheWarmRuntimeHost.close()]);
	}
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	const prefix = cause instanceof CliArgumentError ? "Usage error" : PRODUCT_DISPLAY_NAME;
	console.error(formatCliError(prefix, message, process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"));
	process.exitCode = 2;
}
