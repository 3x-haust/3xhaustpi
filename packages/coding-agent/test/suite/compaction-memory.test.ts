import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionPreparation, compact, generateSummaryWithUsage } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const durableMemory = `## Constraints & Preferences
- Never push or use real API keys.
## Key Decisions
- Use SQLite transactions to preserve atomicity.
## Progress
### In Progress
- Fix the pending migration in src/store.ts.
### Blocked
- SQLITE_BUSY; validation has not passed.
## Operational Evidence
- childSessionId=child-7; npm run check failed.
## Next Steps
1. Close the read transaction and rerun checks.`;

const summaryUsage: Usage = {
	input: 11,
	output: 7,
	cacheRead: 3,
	cacheWrite: 5,
	totalTokens: 26,
	cost: { input: 0.11, output: 0.07, cacheRead: 0.03, cacheWrite: 0.05, total: 0.26 },
};

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: "Remember the pending migration.", timestamp: 1 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 100 },
		...overrides,
	};
}

function appendUser(harness: Harness, text: string): string {
	return harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function appendAssistant(harness: Harness, text: string): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage(text),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
}

describe("compaction memory and budget", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup(contextWindow = 200_000, persistSession = false): Promise<Harness> {
		const harness = await createHarness({
			persistSession,
			models: [{ id: "memory-faux", contextWindow, maxTokens: 128_000 }],
			// These tests cover the standalone, batched summary request.
			settings: { compaction: { keepRecentTokens: 100, reuseCache: false } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("retains the previous checkpoint verbatim when only a split-turn prefix is new", async () => {
		const harness = await setup();
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				prompts.push(getMessageText(context.messages.find((message) => message.role === "user")));
				return fauxAssistantMessage("## Original Request\nContinue the migration; do not push.");
			},
		]);
		const result = await compact(
			preparation({
				messagesToSummarize: [],
				turnPrefixMessages: [{ role: "user", content: "Continue; do not push.", timestamp: 1 }],
				isSplitTurn: true,
				previousSummary: durableMemory,
			}),
			harness.getModel(),
			"faux-key",
			undefined,
			"Keep the unresolved migration and command evidence.",
		);
		expect(result.summary.startsWith(durableMemory)).toBe(true);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Additional focus: Keep the unresolved migration and command evidence.");
		expect(prompts[0]).toContain("unfinished tasks");
	});

	it("carries previous memory and previously retained messages through repeated compaction", async () => {
		const harness = await setup();
		appendUser(harness, "Never push or use real API keys. Fix src/store.ts. ".repeat(20));
		appendAssistant(harness, "Use SQLite transactions to preserve atomicity; migration still pending.");
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(""),
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/store.ts" } },
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/migration.ts" } },
			],
		});
		for (const [toolName, toolCallId] of [
			["read", "read-1"],
			["edit", "edit-1"],
		]) {
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolName,
				toolCallId,
				content: [{ type: "text", text: "SQLITE_BUSY; childSessionId=child-7; validation not passed." }],
				isError: true,
				timestamp: Date.now(),
			});
		}
		for (let round = 0; round < 3; round++) {
			appendUser(harness, `retained-round-${round} ${"continue migration ".repeat(50)}`);
			appendAssistant(harness, "Still pending.");
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			let prompt = "";
			harness.setResponses([
				(context) => {
					prompt = getMessageText(context.messages.find((message) => message.role === "user"));
					return fauxAssistantMessage(durableMemory);
				},
			]);
			const result = await harness.session.compact();
			if (round === 0) {
				expect(prompt).toContain("Never push or use real API keys.");
				expect(prompt).toContain("read#read-1");
				expect(prompt).toContain("status=error");
			} else {
				expect(prompt).toContain(`<previous-summary>\n${durableMemory}\n</previous-summary>`);
				expect(prompt).toContain(`retained-round-${round - 1}`);
				expect(prompt).toContain("silence is not resolution");
			}
			expect(result.details).toMatchObject({
				readFiles: ["src/store.ts"],
				modifiedFiles: ["src/migration.ts"],
				usageRequests: [expect.objectContaining({ source: "compaction", stopReason: "stop" })],
			});
			expect(result.summary.match(/<read-files>/g)).toHaveLength(1);
			expect(result.summary.match(/<modified-files>/g)).toHaveLength(1);
			expect(harness.session.messages[0]?.role).toBe("compactionSummary");
			expect(getMessageText(harness.session.messages[1])).toContain(`retained-round-${round}`);
		}
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("keeps the committed checkpoint prefix unchanged across subsequent delta-only prompts", async () => {
		const harness = await setup();
		appendUser(harness, "Original task. ".repeat(50));
		appendAssistant(harness, "Pending migration.");
		appendUser(harness, "Recent work. ".repeat(50));
		appendAssistant(harness, "Still pending.");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage(durableMemory)]);
		await harness.session.compact();
		const payloads: string[][] = [];
		const systems: Array<string | undefined> = [];
		const response: FauxResponseStep = (context) => {
			payloads.push(context.messages.map((message) => JSON.stringify(message)));
			systems.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("Awaiting validation.");
		};
		harness.setResponses([response, response]);
		await harness.session.prompt("First delta.");
		await harness.session.prompt("Second delta.");
		expect(payloads).toHaveLength(2);
		expect(payloads[0][0]).toContain(durableMemory.split("\n")[0]);
		expect(payloads[1].slice(0, payloads[0].length)).toEqual(payloads[0]);
		expect(systems[1]).toBe(systems[0]);
	});

	it("folds a long multilingual conversation within each request budget without dropping messages", async () => {
		const harness = await setup(16_000);
		const messages: AgentMessage[] = Array.from({ length: 80 }, (_, index) => ({
			role: "user",
			content: `message-${index}: ${"중요한 사용자 지시와 미완료 작업을 보존하세요. ".repeat(8)}`,
			timestamp: index,
		}));
		const seen: string[] = [];
		let calls = 0;
		const response: FauxResponseStep = (context, options) => {
			const prompt = getMessageText(context.messages.find((message) => message.role === "user"));
			expect(
				Buffer.byteLength(getCurrentSystemPrompt(context.messages) + prompt, "utf8") +
					(options?.maxTokens ?? 0) +
					256,
			).toBeLessThanOrEqual(harness.getModel().contextWindow);
			if (calls > 0) expect(prompt).toContain(`<previous-summary>\ncheckpoint-${calls}\n</previous-summary>`);
			seen.push(prompt.slice(prompt.indexOf("<conversation>"), prompt.indexOf("</conversation>")));
			calls++;
			return fauxAssistantMessage(`checkpoint-${calls}`);
		};
		harness.setResponses(Array.from({ length: 80 }, () => response));
		const result = await generateSummaryWithUsage(messages, harness.getModel(), 16_384, "faux-key");
		expect(calls).toBeGreaterThan(1);
		for (let index = 0; index < 80; index++) {
			expect(seen.join("\n").match(new RegExp(`message-${index}:`, "g"))).toHaveLength(1);
		}
		expect(result.text).toBe(`checkpoint-${calls}`);
		expect(result.usage.output).toBe(calls * 3);
		expect(result.usage.totalTokens).toBe(
			result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite,
		);
	});

	it("counts batch and retry usage once across reload without exposing intermediate checkpoints", async () => {
		const harness = await setup(16_000, true);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		for (let index = 0; index < 40; index++) {
			appendUser(harness, `instruction-${index} ${"unfinished work ".repeat(50)}`);
			appendAssistant(harness, "Pending.");
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const response: FauxResponseStep = () => fauxAssistantMessage(durableMemory, { usage: summaryUsage });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: summaryUsage }),
			...Array.from({ length: 40 }, () => response),
		]);
		const result = await harness.session.compact();
		const calls = harness.faux.state.callCount;
		expect(calls).toBeGreaterThan(2);
		expect(result.usage?.input).toBe((calls - 1) * summaryUsage.input);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(1);
		const entries = harness.sessionManager.getEntries();
		const summaries = entries.filter((entry) => entry.type === "compaction");
		expect(summaries).toHaveLength(1);
		const details = summaries[0].details as { usageRequests: Array<{ usage: Usage }> };
		expect(details.usageRequests).toHaveLength(calls - 1);
		expect(details.usageRequests.every((request) => request.usage.input === summaryUsage.input)).toBe(true);
		expect(entries.filter((entry) => entry.type === "custom")).toMatchObject([
			{ customType: "pi.summarization_usage", data: { stopReason: "error", usage: summaryUsage } },
		]);
		const tokens = {
			input: calls * summaryUsage.input,
			output: calls * summaryUsage.output,
			cacheRead: calls * summaryUsage.cacheRead,
			cacheWrite: calls * summaryUsage.cacheWrite,
			total: calls * summaryUsage.totalTokens,
		};
		expect(harness.session.getSessionStats().tokens).toEqual(tokens);
		const messages = structuredClone(harness.session.messages);
		harness.sessionManager.setSessionFile(harness.session.sessionFile!);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		expect(harness.session.getSessionStats().tokens).toEqual(tokens);
		expect(harness.session.messages).toEqual(messages);
	});

	it("continues batching after a valid output expands to many UTF-8 bytes", async () => {
		const harness = await setup(16_000);
		const longCheckpoint = "pending ".repeat(1500);
		const messages: AgentMessage[] = Array.from({ length: 20 }, (_, index) => ({
			role: "user",
			content: `item-${index}: ${"work ".repeat(300)}`,
			timestamp: index,
		}));
		const seen: string[] = [];
		let calls = 0;
		const response: FauxResponseStep = (context, options) => {
			const prompt = getMessageText(context.messages.find((message) => message.role === "user"));
			expect(
				Buffer.byteLength(getCurrentSystemPrompt(context.messages) + prompt, "utf8") +
					(options?.maxTokens ?? 0) +
					256,
			).toBeLessThanOrEqual(16_000);
			seen.push(prompt.slice(0, prompt.indexOf("</conversation>")));
			return fauxAssistantMessage(calls++ === 0 ? longCheckpoint : durableMemory);
		};
		harness.setResponses(Array.from({ length: 30 }, () => response));
		const result = await generateSummaryWithUsage(messages, harness.getModel(), 16_384, "faux-key");
		expect(result.text).toBe(durableMemory);
		for (let index = 0; index < 20; index++) {
			expect(seen.join("\n").match(new RegExp(`item-${index}:`, "g"))).toHaveLength(1);
		}
		expect(calls).toBeGreaterThan(2);
	});

	it("resizes a large previous checkpoint before processing an exchange that would not fit", async () => {
		const harness = await setup(16_000);
		const longCheckpoint = "pending ".repeat(1500);
		const prompts: string[] = [];
		const limits: number[] = [];
		const response: FauxResponseStep = (context, options) => {
			const prompt = getMessageText(context.messages.find((message) => message.role === "user"));
			prompts.push(prompt);
			limits.push(options?.maxTokens ?? 0);
			expect(
				Buffer.byteLength(getCurrentSystemPrompt(context.messages) + prompt, "utf8") +
					(options?.maxTokens ?? 0) +
					256,
			).toBeLessThanOrEqual(16_000);
			return fauxAssistantMessage(durableMemory);
		};
		harness.setResponses([response, response]);
		const result = await generateSummaryWithUsage(
			[{ role: "user", content: `NEW_INSTRUCTION ${"work ".repeat(600)}`, timestamp: 1 }],
			harness.getModel(),
			16_384,
			"faux-key",
			undefined,
			undefined,
			"Preserve every prohibition.",
			longCheckpoint,
		);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain(longCheckpoint);
		expect(prompts[0]).not.toContain("NEW_INSTRUCTION");
		expect(prompts[1]).toContain("NEW_INSTRUCTION");
		expect(prompts[1]).toContain(durableMemory);
		expect(prompts.every((prompt) => prompt.includes("Additional focus: Preserve every prohibition."))).toBe(true);
		expect(limits[0]).toBeLessThan(4000);
		expect(result.text).toBe(durableMemory);
	});

	it("folds checkpoint fragments when an older checkpoint exceeds the new model context", async () => {
		const harness = await setup(16_000);
		const previous = `CHECKPOINT_START ${"중요한 지시🙂 pending ".repeat(1500)} CHECKPOINT_END`;
		const sources: string[] = [];
		const fragments = new Map<number, string>();
		const observed: AssistantMessage[] = [];
		const response: FauxResponseStep = (context, options) => {
			const prompt = getMessageText(context.messages.find((message) => message.role === "user"));
			expect(
				Buffer.byteLength(getCurrentSystemPrompt(context.messages) + prompt, "utf8") +
					(options?.maxTokens ?? 0) +
					256,
			).toBeLessThanOrEqual(16_000);
			sources.push(prompt.slice(0, prompt.indexOf("</conversation>")));
			const conversation = prompt.slice("<conversation>\n".length, prompt.indexOf("\n</conversation>"));
			for (const match of conversation.matchAll(
				/\[User\]: \[Previous checkpoint fragment (\d+)\]\n([\s\S]*?)(?=\n\n\[User\]: \[Previous checkpoint fragment \d+\]\n|$)/g,
			)) {
				const id = Number(match[1]);
				expect(fragments.has(id)).toBe(false);
				fragments.set(id, match[2]);
			}
			return fauxAssistantMessage(durableMemory);
		};
		harness.setResponses(Array.from({ length: 20 }, () => response));
		const result = await generateSummaryWithUsage(
			[{ role: "user", content: "NEW_WORK", timestamp: 1 }],
			harness.getModel(),
			16_384,
			"faux-key",
			undefined,
			undefined,
			undefined,
			previous,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(message) => observed.push(message),
		);
		expect(observed).toHaveLength(harness.faux.state.callCount);
		expect(result.usage.input).toBe(observed.reduce((sum, message) => sum + message.usage.input, 0));
		expect(sources.join("\n")).toContain("CHECKPOINT_START");
		expect(sources.join("\n")).toContain("CHECKPOINT_END");
		expect(sources.filter((source) => source.includes("Previous checkpoint fragment")).length).toBeGreaterThan(1);
		expect(sources.at(-1)).toContain("NEW_WORK");
		expect(
			[...fragments]
				.sort(([left], [right]) => left - right)
				.map(([, text]) => text)
				.join(""),
		).toBe(previous);
		expect(result.text).toBe(durableMemory);
	});

	it("stops checkpoint resizing without truncation when the provider makes no progress", async () => {
		const harness = await setup(16_000);
		const previous = "pending ".repeat(1500);
		harness.setResponses([fauxAssistantMessage(previous)]);
		await expect(
			generateSummaryWithUsage(
				[{ role: "user", content: "new work ".repeat(400), timestamp: 1 }],
				harness.getModel(),
				16_384,
				"faux-key",
				undefined,
				undefined,
				undefined,
				previous,
			),
		).rejects.toThrow("checkpoint resizing made no progress");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("re-summarizes an oversized reused history within the split allocation", async () => {
		const harness = await setup();
		const longCheckpoint = "pending ".repeat(800);
		const limits: number[] = [];
		const response: FauxResponseStep = (context, options) => {
			limits.push(options?.maxTokens ?? 0);
			return fauxAssistantMessage(
				getMessageText(context.messages.find((message) => message.role === "user")).includes(longCheckpoint)
					? durableMemory
					: "## Original Request\nContinue the migration.",
			);
		};
		harness.setResponses([response, response]);
		const result = await compact(
			preparation({
				messagesToSummarize: [],
				previousSummary: longCheckpoint,
				isSplitTurn: true,
				turnPrefixMessages: [{ role: "user", content: "Continue the migration.", timestamp: 1 }],
				settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 },
			}),
			// The checkpoint is oversized relative to the model's output allowance.
			{ ...harness.getModel(), maxTokens: 1000 },
			"faux-key",
		);
		expect(limits).toEqual([1000, 1000]);
		expect(result.summary).toContain(durableMemory);
		expect(result.summary).not.toContain(longCheckpoint);
	});

	it("uses only the turn-prefix format in every prefix batch", async () => {
		const harness = await setup(16_000);
		const prompts: string[] = [];
		const response: FauxResponseStep = (context) => {
			prompts.push(getMessageText(context.messages.find((message) => message.role === "user")));
			return fauxAssistantMessage(
				"## Original Request\nMigration\n## Early Progress\nPending\n## Context for Suffix\nNo push.",
			);
		};
		harness.setResponses(Array.from({ length: 40 }, () => response));
		await compact(
			preparation({
				messagesToSummarize: [],
				isSplitTurn: true,
				turnPrefixMessages: Array.from({ length: 40 }, (_, index) => ({
					role: "user",
					content: `instruction-${index} ${"pending ".repeat(100)}`,
					timestamp: index,
				})),
			}),
			harness.getModel(),
			"faux-key",
		);
		expect(prompts.length).toBeGreaterThan(1);
		for (const prompt of prompts) {
			const instructions = prompt.slice(
				prompt.indexOf("</previous-summary>") >= 0
					? prompt.indexOf("</previous-summary>") + "</previous-summary>".length
					: prompt.indexOf("</conversation>"),
			);
			expect(instructions).toContain("## Original Request");
			expect(instructions).toContain("## Context Needed to Continue");
			expect(instructions).not.toContain("## Goal");
		}
	});

	it("keeps tool exchanges together when a long history needs several requests", async () => {
		const harness = await setup(16_000);
		const messages: AgentMessage[] = [];
		const model = harness.getModel();
		for (let index = 0; index < 15; index++) {
			messages.push(
				{ role: "user", content: `Inspect operation ${index}.`, timestamp: index },
				{
					...fauxAssistantMessage(""),
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: `check-${index}` } },
					],
				},
				{
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: "bash",
					isError: true,
					timestamp: index,
					content: [{ type: "text", text: `result-${index}: ${"failure detail ".repeat(100)}` }],
				},
			);
		}
		let calls = 0;
		const response: FauxResponseStep = (context) => {
			const prompt = getMessageText(context.messages.find((message) => message.role === "user"));
			const conversation = prompt.slice(0, prompt.indexOf("</conversation>"));
			for (let index = 0; index < 15; index++) {
				expect(conversation.includes(`bash#call-${index}(`)).toBe(conversation.includes(`result-${index}:`));
			}
			calls++;
			return fauxAssistantMessage("Operation evidence retained.");
		};
		harness.setResponses(Array.from({ length: 15 }, () => response));
		await generateSummaryWithUsage(messages, model, 16_384, "faux-key");
		expect(calls).toBeGreaterThan(1);
	});

	it("sizes split output from the model output limit and context window, not the reserve", async () => {
		const harness = await setup();
		const limits: number[] = [];
		const response: FauxResponseStep = (_context, options) => {
			limits.push(options?.maxTokens ?? 0);
			return fauxAssistantMessage("checkpoint");
		};
		harness.setResponses([response, response]);
		await compact(
			preparation({
				turnPrefixMessages: [{ role: "user", content: "Current unfinished task", timestamp: 1 }],
				isSplitTurn: true,
			}),
			harness.getModel(),
			"faux-key",
		);
		// History may use half the context window, the split-turn prefix a quarter, both capped by maxTokens.
		const model = harness.getModel();
		const expected = [
			Math.min(model.maxTokens, Math.floor(model.contextWindow / 2)),
			Math.min(model.maxTokens, Math.floor(model.contextWindow / 4)),
		];
		expect(limits).toEqual(expected);
		harness.setResponses([response]);
		await generateSummaryWithUsage([], { ...harness.getModel(), maxTokens: 128 }, 16_384, "faux-key");
		expect(limits.at(-1)).toBe(128);
		harness.setResponses([response, response]);
		await compact(
			preparation({
				turnPrefixMessages: [{ role: "user", content: "Pending work", timestamp: 1 }],
				isSplitTurn: true,
				settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
			}),
			harness.getModel(),
			"faux-key",
		);
		expect(limits.slice(-2)).toEqual(expected);
	});

	it.each(["length", "aborted", "stop"] as const)("does not persist a %s or empty checkpoint", async (stopReason) => {
		const harness = await setup();
		appendUser(harness, "Keep the original instructions. ".repeat(50));
		appendAssistant(harness, "Original work.");
		appendUser(harness, "Recent request. ".repeat(50));
		appendAssistant(harness, "Recent work.");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.session.messages);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		harness.setResponses([
			fauxAssistantMessage(stopReason === "stop" ? " " : "partial checkpoint", { stopReason, usage: summaryUsage }),
		]);
		await expect(harness.session.compact()).rejects.toThrow(/token cap|aborted|empty/);
		const entriesAfter = harness.sessionManager.getEntries();
		expect(entriesAfter.slice(0, entriesBefore.length)).toEqual(entriesBefore);
		expect(entriesAfter.slice(entriesBefore.length)).toMatchObject([
			{ type: "custom", customType: "pi.summarization_usage", data: { stopReason, usage: summaryUsage } },
		]);
		expect(harness.session.messages).toEqual(before);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual(before);
		if (stopReason === "aborted") {
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				aborted: true,
				errorMessage: undefined,
			});
		}
	});

	it("classifies an aborted automatic summary as cancellation without losing history", async () => {
		const harness = await setup();
		appendUser(harness, "Active instructions. ".repeat(50));
		appendAssistant(harness, "Prior work.");
		appendUser(harness, "Recent request. ".repeat(50));
		appendAssistant(harness, "Recent work.");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.session.messages);
		harness.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" })]);
		const internals = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
		};
		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, errorMessage: undefined });
		expect(harness.session.messages).toEqual(before);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("does not persist intermediate summaries if a later batch fails", async () => {
		const harness = await setup(16_000);
		for (let index = 0; index < 40; index++) {
			appendUser(harness, `instruction-${index} ${"unfinished work ".repeat(50)}`);
			appendAssistant(harness, "Pending.");
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.session.messages);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		harness.setResponses([
			fauxAssistantMessage("intermediate checkpoint", { usage: summaryUsage }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", usage: summaryUsage }),
		]);
		await expect(harness.session.compact()).rejects.toThrow("insufficient_quota");
		expect(harness.faux.state.callCount).toBe(2);
		const entriesAfter = harness.sessionManager.getEntries();
		expect(entriesAfter.slice(0, entriesBefore.length)).toEqual(entriesBefore);
		expect(entriesAfter.slice(entriesBefore.length)).toMatchObject([
			{ type: "custom", customType: "pi.summarization_usage", data: { stopReason: "error", usage: summaryUsage } },
			{ type: "custom", customType: "pi.summarization_usage", data: { stopReason: "stop", usage: summaryUsage } },
		]);
		expect(harness.session.getSessionStats()).toMatchObject({
			tokens: { input: 22, output: 14, cacheRead: 6, cacheWrite: 10, total: 52 },
			cost: 0.52,
		});
		expect(harness.session.messages).toEqual(before);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual(before);
	});

	it("rejects a single oversized instruction without a provider call or destructive truncation", async () => {
		const harness = await setup(16_000);
		const messages: AgentMessage[] = [{ role: "user", content: "중요".repeat(10_000), timestamp: 1 }];
		await expect(generateSummaryWithUsage(messages, harness.getModel(), 16_384, "faux-key")).rejects.toThrow(
			"exceeds the summarization context budget",
		);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
