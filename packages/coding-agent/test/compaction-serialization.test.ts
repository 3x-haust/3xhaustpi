import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result name=read id=tc1 status=success]:");
		expect(result).toContain("[... 3000 characters omitted ...]");
		expect(result).not.toContain("x".repeat(3000));
		expect(result).toContain("x".repeat(1000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result name=read id=tc1 status=success]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("retains operational identifiers while omitting private and oversized payloads", () => {
		// Given: reasoning plus a large edit payload with exact operational fields.
		const privateBody = `PRIVATE_BODY_${"x".repeat(6_000)}`;
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_REASONING" },
					{
						type: "toolCall",
						id: "edit-call-7",
						name: "edit",
						arguments: {
							path: "/workspace/src/recovery.ts",
							oldText: privateBody,
							newText: `${privateBody}-replacement`,
						},
					},
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];

		// When: the conversation is serialized for compaction.
		const result = serializeConversation(messages);

		// Then: continuation evidence survives while private bulk is replaced by a stable digest.
		expect(result).toContain("edit-call-7");
		expect(result).toContain("/workspace/src/recovery.ts");
		expect(result).toContain("digest=");
		expect(result).not.toContain("PRIVATE_REASONING");
		expect(result).not.toContain("PRIVATE_BODY_");
	});

	it("keeps both ends of failed tool output with exact status metadata", () => {
		// Given: a failure whose root cause is emitted at the tail.
		const rootCause = "SQLITE_BUSY was caused by an unclosed read transaction.";
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "bash-call-9",
				toolName: "bash",
				content: [{ type: "text", text: `HEAD_MARKER\n${"filler ".repeat(500)}\n${rootCause}` }],
				isError: true,
				timestamp: 1,
			},
		];

		// When: the failed result is bounded for compaction.
		const result = serializeConversation(messages);

		// Then: head, tail, tool identity, and failure status remain machine-visible.
		expect(result).toContain("HEAD_MARKER");
		expect(result).toContain(rootCause);
		expect(result).toContain("bash-call-9");
		expect(result).toContain("status=error");
	});
});
