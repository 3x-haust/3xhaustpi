import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { createSummarizationUsageTracker } from "../src/core/summarization-usage.ts";
import { getEntryUsage, getUsageCostBreakdown } from "../src/core/usage-totals.ts";

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

describe("standalone summarization usage records", () => {
	it("snapshots usage and metadata, and does not emit duplicate records when finishing twice", () => {
		const manager = SessionManager.inMemory();
		const tracker = createSummarizationUsageTracker(manager, "compaction");
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			responseId: "failed-request",
			usage: structuredClone(usage),
		});
		tracker.onResponse(message);
		message.usage.cacheRead = 999;
		tracker.finish();
		tracker.finish();
		const entries = manager.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: "pi.summarization_usage",
			data: { source: "compaction", responseId: "failed-request", stopReason: "error", usage },
		});
		expect(getEntryUsage(entries[0])).toEqual(usage);
		expect(manager.buildSessionContext().messages).toEqual([]);
		expect(getUsageCostBreakdown(entries)).toEqual([{ key: "Tools/summaries", cost: 1, tokens: 10 }]);
	});

	it("attributes discarded and late successful responses to the captured manager", () => {
		const original = SessionManager.inMemory();
		const root = original.appendMessage({ role: "user", content: "root", timestamp: 0 });
		const tracker = createSummarizationUsageTracker(original, "branchSummary");
		tracker.onResponse(fauxAssistantMessage("discarded", { usage }));
		const replacement = original.forkInMemory(root);
		tracker.finish();
		tracker.onResponse(fauxAssistantMessage("late", { usage }));
		tracker.finish();
		expect(original.getEntries()).toHaveLength(3);
		expect(replacement.getEntries()).toHaveLength(1);
		expect(replacement.getSessionId()).not.toBe(original.getSessionId());
		expect(getUsageCostBreakdown(replacement.getEntries())).toEqual([]);
		expect(getUsageCostBreakdown(original.getEntries())).toEqual([{ key: "Tools/summaries", cost: 2, tokens: 20 }]);
	});

	it.each([
		null,
		{},
		{ usage: {} },
		{ usage: { ...usage, cacheRead: "3" } },
		{ usage: { ...usage, cost: { ...usage.cost, total: NaN } } },
	])("ignores malformed custom usage data: %j", (data) => {
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomEntry("pi.summarization_usage", data);
		expect(getEntryUsage(manager.getEntry(id)!)).toBeUndefined();
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([]);
	});

	it("flushes and forks usage-only sessions without requiring an assistant or duplicating the header", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-summary-usage-"));
		try {
			const manager = SessionManager.create(tempDir, tempDir);
			const tracker = createSummarizationUsageTracker(manager, "compaction");
			tracker.onResponse(fauxAssistantMessage("", { stopReason: "error", usage }));
			tracker.finish();
			expect(loadEntriesFromFile(manager.getSessionFile()!)).toHaveLength(2);
			const fork = manager.createBranchedSession(manager.getLeafId()!)!;
			manager.appendCustomEntry("metadata", { value: 1 });
			const saved = loadEntriesFromFile(fork);
			expect(saved.filter((entry) => entry.type === "session")).toHaveLength(1);
			expect(getUsageCostBreakdown(SessionManager.open(fork).getEntries())).toEqual([
				{ key: "Tools/summaries", cost: 1, tokens: 10 },
			]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
