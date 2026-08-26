import type { Message, Usage } from "@earendil-works/pi-ai";
import type { CompactionRetentionExpectation } from "./compaction-score.ts";

export interface CompactionBenchmarkCase {
	readonly id: string;
	readonly messages: readonly Message[];
	readonly expectations: readonly CompactionRetentionExpectation[];
}

const usage: Usage = {
	input: 2_000,
	output: 200,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2_200,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const editBody = `PRIVATE_EDIT_BODY_${"x".repeat(6_000)}`;
const errorTail = "SQLITE_BUSY was caused by an unclosed read transaction.";

const toolHeavyMessages: readonly Message[] = [
	{
		role: "user",
		content: "Deployment fact: active region is eu-west-1.",
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" },
			{
				type: "text",
				text: "Decision: retain SQLite because crash recovery is required. Open task: add migration coverage for schema version 7.",
			},
			{
				type: "toolCall",
				id: "tool-edit-1",
				name: "edit",
				arguments: {
					path: "/workspace/src/session/recovery.ts",
					oldText: editBody,
					newText: `${editBody}-replacement`,
				},
			},
			{
				type: "toolCall",
				id: "tool-bash-1",
				name: "bash",
				arguments: { command: "npm run test -- session-recovery.test.ts" },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "benchmark",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "tool-bash-1",
		toolName: "bash",
		content: [{ type: "text", text: `${"diagnostic filler ".repeat(180)}\n${errorTail}` }],
		isError: true,
		timestamp: 3,
	},
];

export const COMPACTION_BENCHMARK_CORPUS: readonly CompactionBenchmarkCase[] = [
	{
		id: "tool-heavy",
		messages: toolHeavyMessages,
		expectations: [
			{ id: "region", category: "fact", required: ["active region is eu-west-1"] },
			{ id: "sqlite", category: "decision", required: ["retain SQLite"] },
			{ id: "migration", category: "open_task", required: ["add migration coverage for schema version 7"] },
			{ id: "path", category: "path", required: ["/workspace/src/session/recovery.ts"] },
			{
				id: "command",
				category: "command",
				required: ["npm run test -- session-recovery.test.ts"],
				forbidden: ["PRIVATE_EDIT_BODY_"],
			},
			{
				id: "error",
				category: "error_cause",
				required: [errorTail],
				forbidden: ["PRIVATE_REASONING_SENTINEL"],
			},
		],
	},
];
