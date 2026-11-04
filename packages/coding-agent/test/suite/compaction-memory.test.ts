import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
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

	async function setup(contextWindow = 200_000): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "memory-faux", contextWindow, maxTokens: 128_000 }],
			settings: { compaction: { keepRecentTokens: 100 } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("retains the previous checkpoint verbatim when only a split-turn prefix is new", async () => {
		const harness = await setup();
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				prompts.push(getMessageText(context.messages[0]));
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
					prompt = getMessageText(context.messages[0]);
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
			expect(result.details).toEqual({ readFiles: ["src/store.ts"], modifiedFiles: ["src/migration.ts"] });
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
			systems.push(context.systemPrompt);
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
			const prompt = getMessageText(context.messages[0]);
			expect(
				Buffer.byteLength((context.systemPrompt ?? "") + prompt, "utf8") + (options?.maxTokens ?? 0) + 256,
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
			const prompt = getMessageText(context.messages[0]);
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

	it("bounds combined split output below the reserve and respects smaller model caps", async () => {
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
		expect(limits).toEqual([4096, 2048]);
		expect(limits.reduce((sum, value) => sum + value, 0)).toBeLessThan(16_384);
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
		expect(limits.slice(-2)).toEqual([500, 300]);
	});

	it.each(["length", "aborted", "stop"] as const)("does not persist a %s or empty checkpoint", async (stopReason) => {
		const harness = await setup();
		appendUser(harness, "Keep the original instructions. ".repeat(50));
		appendAssistant(harness, "Original work.");
		appendUser(harness, "Recent request. ".repeat(50));
		appendAssistant(harness, "Recent work.");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.session.messages);
		const entriesBefore = harness.sessionManager.getEntries().length;
		harness.setResponses([fauxAssistantMessage(stopReason === "stop" ? " " : "partial checkpoint", { stopReason })]);
		await expect(harness.session.compact()).rejects.toThrow(/truncated|aborted|empty/);
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.session.messages).toEqual(before);
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
		const entriesBefore = harness.sessionManager.getEntries().length;
		harness.setResponses([
			fauxAssistantMessage("intermediate checkpoint"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		]);
		await expect(harness.session.compact()).rejects.toThrow("insufficient_quota");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(harness.session.messages).toEqual(before);
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
