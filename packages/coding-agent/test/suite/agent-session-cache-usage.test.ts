import { fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStats } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function usage(input: number, cacheRead: number, cacheWrite: number, output = 20): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	};
}

function expectTotals(stats: SessionStats, usages: Usage[]): void {
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const item of usages) {
		tokens.input += item.input;
		tokens.output += item.output;
		tokens.cacheRead += item.cacheRead;
		tokens.cacheWrite += item.cacheWrite;
		tokens.total += item.input + item.output + item.cacheRead + item.cacheWrite;
	}
	expect(stats.tokens).toEqual(tokens);
	expect(stats.cost).toBe(usages.reduce((sum, item) => sum + item.cost.total, 0));
}

function reload(harness: Harness): void {
	const path = harness.session.sessionFile;
	if (!path) throw new Error("Expected a persisted session");
	harness.sessionManager.setSessionFile(path);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("request cache usage and session totals", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("records cold, 74% hit, and full-miss requests once, including at message_end and after reload", async () => {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const requests = [usage(10_000, 0, 0), usage(600, 7_400, 2_000), usage(8_000, 0, 2_000)];
		harness.setResponses(requests.map((item) => fauxAssistantMessage("streamed response", { usage: item })));
		const completed: Usage[] = [];
		let updates = 0;
		harness.session.subscribe((event) => {
			if (event.type === "message_update") {
				updates++;
				expectTotals(harness.session.getSessionStats(), completed);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				completed.push(structuredClone(event.message.usage));
				expectTotals(harness.session.getSessionStats(), completed);
			}
		});

		for (let i = 0; i < requests.length; i++) {
			await harness.session.prompt(`request ${i}`);
			expectTotals(harness.session.getSessionStats(), requests.slice(0, i + 1));
			reload(harness);
			expectTotals(harness.session.getSessionStats(), requests.slice(0, i + 1));
		}
		expect(updates).toBeGreaterThan(requests.length);
		expect(completed).toEqual(requests);
		const saved = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message.usage] : [],
			);
		expect(saved).toEqual(requests);
		expect(harness.session.getSessionStats().assistantMessages).toBe(3);
	});

	it("persists extension-finalized cache usage before publishing completion", async () => {
		const raw = usage(100, 200, 300);
		const finalized = usage(10, 20, 30);
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") return { message: { ...event.message, usage: finalized } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("response", { usage: raw })]);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				expect(event.message.usage).toEqual(finalized);
				expectTotals(harness.session.getSessionStats(), [finalized]);
			}
		});
		await harness.session.prompt("hello");
		reload(harness);
		expectTotals(harness.session.getSessionStats(), [finalized]);
	});

	it("keeps reported usage from failed, retried, and aborted requests without counting updates twice", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const requests = [usage(10, 100, 20), usage(20, 200, 30), usage(30, 300, 40)];
		harness.setResponses([
			fauxAssistantMessage("failed", { usage: requests[0], stopReason: "error", errorMessage: "503 overloaded" }),
			fauxAssistantMessage("retried", { usage: requests[1] }),
			fauxAssistantMessage("aborted", { usage: requests[2], stopReason: "aborted" }),
		]);
		await harness.session.prompt("retry");
		expectTotals(harness.session.getSessionStats(), requests.slice(0, 2));
		await harness.session.prompt("abort");
		expectTotals(harness.session.getSessionStats(), requests);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), requests);
		expect(harness.session.getSessionStats().assistantMessages).toBe(3);
	});

	it("counts tool usage once, separately from the assistant requests around it", async () => {
		const nested = usage(3, 30, 300);
		const requests = [usage(1, 10, 100), usage(2, 20, 200)];
		const harness = await createHarness({
			persistSession: true,
			tools: [
				{
					name: "nested",
					label: "Nested",
					description: "Reports nested model usage",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "result" }], details: {}, usage: nested }),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("nested", {}), { usage: requests[0], stopReason: "toolUse" }),
			fauxAssistantMessage("done", { usage: requests[1] }),
		]);
		await harness.session.prompt("run tool");
		expectTotals(harness.session.getSessionStats(), [...requests, nested]);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), [...requests, nested]);
		expect(harness.session.getSessionStats()).toMatchObject({ assistantMessages: 2, toolCalls: 1, toolResults: 1 });
	});

	it("retains pre-compaction totals and adds only summary generation usage", async () => {
		const request = usage(1, 10, 100);
		const summary = usage(2, 20, 200);
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("response", { usage: request }),
			fauxAssistantMessage("summary", { usage: summary }),
		]);
		await harness.session.prompt("compact this conversation");
		const result = await harness.session.compact();
		expect(result.usage).toEqual(summary);
		expectTotals(harness.session.getSessionStats(), [request, summary]);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), [request, summary]);
		expect(harness.session.getSessionStats().contextUsage?.tokens).toBeNull();
	});

	it("persists individual successful split-summary requests without adding their aggregate twice", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const requests = [usage(1, 10, 100), usage(2, 20, 200), usage(3, 30, 300), usage(4, 40, 400)];
		harness.setResponses(requests.map((item) => fauxAssistantMessage("response", { usage: item })));
		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");
		const result = await harness.session.compact();
		expect(harness.faux.state.callCount).toBe(4);
		expect(result.details).toMatchObject({
			usageRequests: expect.arrayContaining(
				requests.slice(2).map((item) =>
					expect.objectContaining({
						usage: item,
						source: "compaction",
						provider: harness.getModel().provider,
						model: harness.getModel().id,
						stopReason: "stop",
					}),
				),
			),
		});
		const saved = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(saved?.type === "compaction" ? saved.details : undefined).toEqual(result.details);
		expectTotals(harness.session.getSessionStats(), requests);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), requests);
		const reloaded = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(reloaded?.type === "compaction" ? reloaded.details : undefined).toMatchObject({
			usageRequests: expect.arrayContaining([
				expect.objectContaining({ usage: requests[2] }),
				expect.objectContaining({ usage: requests[3] }),
			]),
		});
	});

	it("includes failed auto-compaction attempts and the successful summary once at completion", async () => {
		const harness = await createHarness({
			persistSession: true,
			// Include room for the checkpoint instructions while still triggering automatic compaction.
			models: [{ id: "faux-1", contextWindow: 16_000, maxTokens: 200 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
		});
		harnesses.push(harness);
		const attempts = [usage(15_600, 200, 0), usage(20, 30, 40), usage(10, 0, 50)];
		harness.setResponses([
			fauxAssistantMessage("response", { usage: attempts[0] }),
			fauxAssistantMessage("", { usage: attempts[1], stopReason: "error", errorMessage: "terminated" }),
			fauxAssistantMessage("summary", { usage: attempts[2] }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") expectTotals(harness.session.getSessionStats(), attempts);
		});
		await harness.session.prompt("automatic compaction");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			result: { summary: expect.stringContaining("summary") },
		});
		expectTotals(harness.session.getSessionStats(), attempts);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), attempts);
	});

	it("records a successful summary response discarded by cancellation after retry completion", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
		});
		harnesses.push(harness);
		const attempts = [usage(1, 10, 100), usage(2, 20, 200), usage(3, 30, 300)];
		harness.setResponses([
			fauxAssistantMessage("response", { usage: attempts[0] }),
			fauxAssistantMessage("", { usage: attempts[1], stopReason: "error", errorMessage: "terminated" }),
			fauxAssistantMessage("discarded summary", { usage: attempts[2] }),
		]);
		await harness.session.prompt("compact this");
		harness.session.subscribe((event) => {
			if (event.type === "summarization_retry_finished") harness.session.abortCompaction();
			if (event.type === "compaction_end") expectTotals(harness.session.getSessionStats(), attempts);
		});
		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), attempts);
	});

	it("includes abandoned branches in the original session but only copied history in a branch fork", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const root = usage(1, 10, 100);
		const abandoned = usage(2, 20, 200);
		const summary = usage(3, 30, 300);
		const newBranch = usage(4, 40, 400);
		const allUsage = [root, abandoned, summary, newBranch];
		harness.setResponses(allUsage.map((item) => fauxAssistantMessage("response", { usage: item })));
		await harness.session.prompt("root");
		const rootLeaf = harness.sessionManager.getLeafId()!;
		await harness.session.prompt("abandoned branch");
		await harness.session.navigateTree(rootLeaf, { summarize: true });
		// Summarizing the abandoned branch adds usage; replaying the root adds none.
		expectTotals(harness.session.getSessionStats(), [root, abandoned, summary]);
		await harness.session.prompt("new branch");
		expectTotals(harness.session.getSessionStats(), allUsage);
		const sourceFile = harness.session.sessionFile!;
		reload(harness);
		expectTotals(harness.session.getSessionStats(), allUsage);

		const fullCopy = SessionManager.forkFrom(sourceFile, harness.tempDir, harness.sessionManager.getSessionDir());
		harness.sessionManager.setSessionFile(fullCopy.getSessionFile()!);
		expectTotals(harness.session.getSessionStats(), allUsage);

		const forkFile = harness.sessionManager.createBranchedSession(harness.sessionManager.getLeafId()!);
		expect(forkFile).toBeDefined();
		// Root request + branch summary request + new-branch request; abandoned request is not copied.
		expectTotals(harness.session.getSessionStats(), [root, summary, newBranch]);
		reload(harness);
		expectTotals(harness.session.getSessionStats(), [root, summary, newBranch]);
	});
});
