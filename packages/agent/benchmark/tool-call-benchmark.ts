import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";
import {
	evaluateToolCallBenchmark,
	summarizeToolCallBenchmark,
	type ToolCallBenchmarkAcceptance,
	type ToolCallBenchmarkSample,
	type ToolCallBenchmarkSummary,
	type ToolCallBenchmarkThresholds,
	type ToolCallExecutionMode,
} from "./tool-call-score.ts";

export interface ToolCallBenchmarkConfig {
	readonly batchSize: number;
	readonly warmups: number;
	readonly repetitions: number;
	readonly thresholds?: ToolCallBenchmarkThresholds;
}

export interface ToolCallModeResult {
	readonly mode: ToolCallExecutionMode;
	readonly summary: ToolCallBenchmarkSummary;
	readonly acceptance: ToolCallBenchmarkAcceptance;
}

export interface ToolCallBenchmarkReport {
	readonly schemaVersion: 1;
	readonly mode: "local-agent-loop";
	readonly runtime: {
		readonly node: string;
		readonly platform: NodeJS.Platform;
		readonly arch: string;
	};
	readonly config: ToolCallBenchmarkConfig;
	readonly results: readonly ToolCallModeResult[];
	readonly acceptance: ToolCallBenchmarkAcceptance;
}

class ToolCallBenchmarkError extends Error {
	readonly name = "ToolCallBenchmarkError";
}

const DEFAULT_THRESHOLDS = {
	minimumExecutionSuccessRate: 1,
	minimumContractSuccessRate: 1,
	minimumThroughputCallsPerSecond: 1_000,
	maximumP95LatencyMs: 50,
} as const satisfies ToolCallBenchmarkThresholds;

const TOOL_PARAMETERS = Type.Object({ index: Type.Integer({ minimum: 0 }) });

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "tool-call-benchmark",
		name: "tool-call-benchmark",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://benchmark.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "tool-call-benchmark",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(): UserMessage {
	return { role: "user", content: "run benchmark tools", timestamp: Date.now() };
}

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message) => {
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			return [message];
		}
		return [];
	});
}

function createProviderStream(toolCalls: AssistantMessage["content"]): StreamFn {
	let turn = 0;
	return () => {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new ToolCallBenchmarkError("Provider stream ended without a final event");
			},
		);
		queueMicrotask(() => {
			if (turn === 0) {
				turn++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(toolCalls, "toolUse"),
				});
				return;
			}
			turn++;
			stream.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "done" }], "stop"),
			});
		});
		return stream;
	};
}

function contractSucceeded(result: ToolResultMessage, index: number): boolean {
	return (
		result.toolCallId === `tool-${index}` &&
		result.content.some((content) => content.type === "text" && content.text === `ok:${index}`)
	);
}

async function runBatch(mode: ToolCallExecutionMode, batchSize: number): Promise<ToolCallBenchmarkSample> {
	const toolCalls: AssistantMessage["content"] = Array.from({ length: batchSize }, (_, index) => ({
		type: "toolCall",
		id: `tool-${index}`,
		name: "benchmark_echo",
		arguments: { index },
	}));
	const tool: AgentTool<typeof TOOL_PARAMETERS, { readonly index: number }> = {
		name: "benchmark_echo",
		label: "Benchmark echo",
		description: "Return the validated benchmark index",
		parameters: TOOL_PARAMETERS,
		async execute(_toolCallId, parameters) {
			return {
				content: [{ type: "text", text: `ok:${parameters.index}` }],
				details: { index: parameters.index },
			};
		},
	};
	const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm,
		toolExecution: mode,
	};
	let completed = 0;
	let succeeded = 0;
	const emit = (event: AgentEvent) => {
		if (event.type !== "tool_execution_end") return;
		completed++;
		if (!event.isError) succeeded++;
	};

	const startedAt = performance.now();
	const messages = await runAgentLoop(
		[createUserMessage()],
		context,
		config,
		emit,
		undefined,
		createProviderStream(toolCalls),
	);
	const durationMs = performance.now() - startedAt;
	const toolResults = messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
	const successfulContracts = toolResults.reduce(
		(total, result, index) => total + (contractSucceeded(result, index) ? 1 : 0),
		0,
	);
	return {
		mode,
		requested: batchSize,
		succeeded,
		contractSucceeded: successfulContracts,
		orphaned: Math.max(0, batchSize - completed),
		durationMs,
	};
}

async function runMode(
	mode: ToolCallExecutionMode,
	config: ToolCallBenchmarkConfig,
	thresholds: ToolCallBenchmarkThresholds,
): Promise<ToolCallModeResult> {
	for (let index = 0; index < config.warmups; index++) {
		await runBatch(mode, config.batchSize);
	}
	const samples: ToolCallBenchmarkSample[] = [];
	for (let index = 0; index < config.repetitions; index++) {
		samples.push(await runBatch(mode, config.batchSize));
	}
	const summary = summarizeToolCallBenchmark(samples);
	return { mode, summary, acceptance: evaluateToolCallBenchmark(summary, thresholds) };
}

export async function runToolCallBenchmark(config: ToolCallBenchmarkConfig): Promise<ToolCallBenchmarkReport> {
	const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
	const modes = ["parallel", "sequential"] as const;
	const results = await Promise.all(modes.map((mode) => runMode(mode, config, thresholds)));
	const violations = results.flatMap((result) =>
		result.acceptance.violations.map((violation) => `${result.mode}: ${violation}`),
	);
	return {
		schemaVersion: 1,
		mode: "local-agent-loop",
		runtime: { node: process.version, platform: process.platform, arch: process.arch },
		config,
		results,
		acceptance: { passed: violations.length === 0, violations },
	};
}

