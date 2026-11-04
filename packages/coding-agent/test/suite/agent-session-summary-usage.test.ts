import { existsSync } from "node:fs";
import { type AssistantMessage, fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import { buildSessionContext, type SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function usage(scale: number): Usage {
	return {
		input: scale,
		output: 2 * scale,
		cacheRead: 3 * scale,
		cacheWrite: 5 * scale,
		totalTokens: 11 * scale,
		cost: { input: scale, output: 2 * scale, cacheRead: 3 * scale, cacheWrite: 5 * scale, total: 11 * scale },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function appendUser(harness: Harness, text: string): string {
	return harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function appendAssistant(harness: Harness, text: string): string {
	const model = harness.getModel();
	return harness.sessionManager.appendMessage({
		...fauxAssistantMessage(text, { usage: usage(0) }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
}

function seedSession(harness: Harness): { targetId: string; leafId: string } {
	appendUser(harness, "first request to summarize");
	const targetId = appendAssistant(harness, "first response to summarize");
	const leafId = appendUser(harness, "recent request to retain");
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return { targetId, leafId };
}

function customUsages(entries: SessionEntry[]): Usage[] {
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === "pi.summarization_usage")
		.map((entry) => {
			if (entry.type !== "custom") throw new Error("Expected custom usage entry");
			return (entry.data as { usage: Usage }).usage;
		});
}

function expectUsage(harness: Harness, expected: Usage[], custom: Usage[]): void {
	const scale = expected.reduce((sum, value) => sum + value.input, 0);
	const total = usage(scale);
	expect(harness.session.getSessionStats()).toMatchObject({
		tokens: {
			input: total.input,
			output: total.output,
			cacheRead: total.cacheRead,
			cacheWrite: total.cacheWrite,
			total: total.totalTokens,
		},
		cost: total.cost.total,
	});
	expect(customUsages(harness.sessionManager.getEntries())).toEqual(custom);
}

function expectUsageAfterReload(harness: Harness, expected: Usage[], custom: Usage[]): void {
	expectUsage(harness, expected, custom);
	const sessionFile = harness.session.sessionFile;
	expect(sessionFile).toBeDefined();
	expect(existsSync(sessionFile!)).toBe(true);
	harness.sessionManager.setSessionFile(sessionFile!);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	expectUsage(harness, expected, custom);
}

describe("AgentSession summarization usage accounting", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness({
			persistSession: true,
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it("counts two failed manual compaction attempts and one successful summary exactly once", async () => {
		const harness = await setup();
		seedSession(harness);
		const attempts = [usage(1), usage(10), usage(100)];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: attempts[0] }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: attempts[1] }),
			fauxAssistantMessage("recovered summary", { usage: attempts[2] }),
		]);

		const result = await harness.session.compact();

		expect(result.usage).toEqual(attempts[2]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(2);
		const summaries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.usage).toEqual(attempts[2]);
		expectUsageAfterReload(harness, attempts, attempts.slice(0, 2));
	});

	it("does not also write successful manual summary usage to a custom entry", async () => {
		const harness = await setup();
		seedSession(harness);
		const summaryUsage = usage(7);
		harness.setResponses([fauxAssistantMessage("summary", { usage: summaryUsage })]);

		const result = await harness.session.compact();

		expect(result.usage).toEqual(summaryUsage);
		expectUsageAfterReload(harness, [summaryUsage], []);
	});

	it.each(["error", "aborted"] as const)(
		"persists a terminal %s manual summary response across reload",
		async (stopReason) => {
			const harness = await setup();
			seedSession(harness);
			const failedUsage = usage(9);
			harness.setResponses([
				() => {
					if (stopReason === "aborted") harness.session.abortCompaction();
					return fauxAssistantMessage("", { stopReason, errorMessage: "insufficient_quota", usage: failedUsage });
				},
			]);

			await expect(harness.session.compact()).rejects.toThrow();

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expectUsageAfterReload(harness, [failedUsage], [failedUsage]);
		},
	);

	it("persists every manual summary response when the retry budget is exhausted", async () => {
		const harness = await setup();
		seedSession(harness);
		const attempts = [usage(1), usage(2), usage(3)];
		harness.setResponses(
			attempts.map((value) =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: value }),
			),
		);

		await expect(harness.session.compact()).rejects.toThrow("terminated");

		expect(harness.faux.state.callCount).toBe(3);
		expectUsageAfterReload(harness, attempts, attempts);
	});

	it("counts the real response once when aborting backoff synthesizes an abort with the same usage", async () => {
		const harness = await setup();
		seedSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 30_000 } });
		const failedUsage = usage(13);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: failedUsage }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") harness.session.abortCompaction();
		});

		await expect(harness.session.compact()).rejects.toThrow();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
		expectUsageAfterReload(harness, [failedUsage], [failedUsage]);
	});

	it.each(["error", "aborted"] as const)(
		"keeps branch context and %s summary usage when navigation does not complete",
		async (stopReason) => {
			const harness = await setup();
			const { targetId } = seedSession(harness);
			const leafId = appendAssistant(harness, "abandoned branch response");
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const messagesBefore = structuredClone(harness.session.messages);
			const failedUsage = usage(17);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason, errorMessage: "insufficient_quota", usage: failedUsage }),
			]);

			const navigation = harness.session.navigateTree(targetId, { summarize: true });
			if (stopReason === "error") await expect(navigation).rejects.toThrow("insufficient_quota");
			else await expect(navigation).resolves.toMatchObject({ cancelled: true, aborted: true });

			expect(harness.sessionManager.getBranch().some((entry) => entry.id === leafId)).toBe(true);
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.sessionManager.buildSessionContext().messages).toEqual(messagesBefore);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toHaveLength(0);
			expectUsageAfterReload(harness, [failedUsage], [failedUsage]);
			expect(harness.sessionManager.buildSessionContext().messages).toEqual(messagesBefore);
		},
	);

	it("preserves branch retry usage without double counting the successful summary or changing its target", async () => {
		const harness = await setup();
		const { targetId } = seedSession(harness);
		appendAssistant(harness, "abandoned branch response");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const targetMessages = buildSessionContext(harness.sessionManager.getBranch(targetId)).messages;
		const attempts = [usage(2), usage(20), usage(200)];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: attempts[0] }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: attempts[1] }),
			fauxAssistantMessage("branch summary", { usage: attempts[2] }),
		]);

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry).toMatchObject({ type: "branch_summary", parentId: targetId, usage: attempts[2] });
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.messages.slice(0, -1)).toEqual(targetMessages);
		expect(harness.session.messages.at(-1)?.role).toBe("branchSummary");
		const messagesAfter = structuredClone(harness.session.messages);
		expectUsageAfterReload(harness, attempts, attempts.slice(0, 2));
		expect(harness.session.messages).toEqual(messagesAfter);
	});

	it("preserves branch usage and context when cancelling retry backoff", async () => {
		const harness = await setup();
		const { targetId, leafId } = seedSession(harness);
		const messagesBefore = structuredClone(harness.session.messages);
		const failedUsage = usage(23);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 30_000 } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated", usage: failedUsage }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") harness.session.abortBranchSummary();
		});

		await expect(harness.session.navigateTree(targetId, { summarize: true })).resolves.toMatchObject({
			cancelled: true,
			aborted: true,
		});

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getBranch().some((entry) => entry.id === leafId)).toBe(true);
		expect(harness.session.messages).toEqual(messagesBefore);
		expectUsageAfterReload(harness, [failedUsage], [failedUsage]);
		expect(harness.session.messages).toEqual(messagesBefore);
	});

	it("retains a late parallel split-turn response after the other summarization has failed", async () => {
		const harness = await setup();
		// Parallel history and turn-prefix requests exist only on the standalone summary path.
		harness.settingsManager.applyOverrides({ compaction: { reuseCache: false } });
		seedSession(harness);
		appendAssistant(harness, "turn prefix work");
		appendAssistant(harness, "recent turn suffix to retain");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const preparation = prepareCompaction(
			harness.sessionManager.getBranch(),
			harness.settingsManager.getCompactionSettings(),
		);
		expect(preparation?.isSplitTurn).toBe(true);
		expect(preparation?.messagesToSummarize.length).toBeGreaterThan(0);
		expect(preparation?.turnPrefixMessages.length).toBeGreaterThan(0);
		const failedUsage = usage(29);
		const siblingUsage = usage(31);
		const siblingStarted = deferred<void>();
		const releaseSibling = deferred<AssistantMessage>();
		const siblingFinished = deferred<void>();
		const streamFunction = harness.session.agent.streamFunction!;
		harness.session.agent.streamFunction = (model, context, options) => {
			const stream = streamFunction(model, context, options);
			void Promise.resolve(stream).then(async (responseStream) => {
				const response = await responseStream.result();
				if (response.usage.cacheRead === siblingUsage.cacheRead) siblingFinished.resolve();
			});
			return stream;
		};
		harness.setResponses([
			async () => {
				await siblingStarted.promise;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "insufficient_quota",
					usage: failedUsage,
				});
			},
			async () => {
				siblingStarted.resolve();
				return releaseSibling.promise;
			},
		]);

		const compaction = harness.session.compact();
		try {
			await expect(compaction).rejects.toThrow("insufficient_quota");
		} finally {
			releaseSibling.resolve(fauxAssistantMessage("late turn prefix summary", { usage: siblingUsage }));
			await siblingFinished.promise;
		}

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expectUsageAfterReload(harness, [failedUsage, siblingUsage], [failedUsage, siblingUsage]);
	});

	it("writes failed summarization usage to disk even before the first assistant in a user-only session", async () => {
		const harness = await setup();
		appendUser(harness, "old user request");
		appendUser(harness, "latest user request");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const failedUsage = usage(37);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", usage: failedUsage }),
		]);

		await expect(harness.session.compact()).rejects.toThrow("insufficient_quota");

		expect(harness.session.getSessionStats().assistantMessages).toBe(0);
		const sessionFile = harness.session.sessionFile!;
		expect(existsSync(sessionFile)).toBe(true);
		expectUsageAfterReload(harness, [failedUsage], [failedUsage]);
		expect(harness.session.getSessionStats()).toMatchObject({ userMessages: 2, assistantMessages: 0 });
	});

	it("persists ordinary assistant abort usage when manual compaction interrupts the active agent", async () => {
		const harness = await setup();
		seedSession(harness);
		const agentUsage = usage(41);
		const summaryUsage = usage(43);
		const agentStarted = deferred<void>();
		harness.setResponses([
			async (_context, options) => {
				agentStarted.resolve();
				return new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("", { stopReason: "aborted", usage: agentUsage })),
						{ once: true },
					);
				});
			},
			fauxAssistantMessage("summary after abort", { usage: summaryUsage }),
		]);

		const prompt = harness.session.prompt("active request");
		await agentStarted.promise;
		await harness.session.compact();
		await prompt;

		const aborted = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
			);
		expect(aborted).toHaveLength(1);
		expectUsageAfterReload(harness, [agentUsage, summaryUsage], []);
	});
});
