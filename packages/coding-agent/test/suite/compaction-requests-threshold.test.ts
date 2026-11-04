import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	estimateWeightedChars,
	formatUserRequestsSection,
	getCompactionThreshold,
	shouldCompact,
	stripUserRequests,
} from "../../src/core/compaction/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };

describe("compaction threshold cap", () => {
	it("caps the threshold on large windows and keeps the window edge on small ones", () => {
		expect(getCompactionThreshold(1_000_000, { ...settings, maxContextTokens: 300_000 })).toBe(300_000);
		expect(getCompactionThreshold(200_000, { ...settings, maxContextTokens: 300_000 })).toBe(200_000 - 16_384);
		expect(getCompactionThreshold(1_000_000, { ...settings, maxContextTokens: 0 })).toBe(1_000_000 - 16_384);
		expect(getCompactionThreshold(1_000_000, settings)).toBe(1_000_000 - 16_384);
	});

	it("shouldCompact triggers at the cap", () => {
		const capped = { ...settings, maxContextTokens: 300_000 };
		expect(shouldCompact(299_999, 1_000_000, capped)).toBe(false);
		expect(shouldCompact(300_001, 1_000_000, capped)).toBe(true);
		expect(shouldCompact(300_001, 1_000_000, { ...capped, enabled: false })).toBe(false);
	});

	it("defaults to a 300k cap in code and in settings, and 0 disables it", () => {
		expect(DEFAULT_COMPACTION_SETTINGS.maxContextTokens).toBe(300_000);
		expect(SettingsManager.inMemory().getCompactionMaxContextTokens()).toBe(300_000);
		expect(SettingsManager.inMemory({ compaction: { maxContextTokens: 0 } }).getCompactionMaxContextTokens()).toBe(0);
	});
});

describe("weighted token estimate", () => {
	it("counts ASCII as before and weights two- and three-byte characters", () => {
		expect(estimateWeightedChars("abcd")).toBe(4);
		expect(estimateWeightedChars("é")).toBe(2);
		expect(estimateWeightedChars("한국어")).toBe(12);
		expect(estimateWeightedChars("漢字かな")).toBe(16);
	});

	it("estimates about one token per Hangul character", () => {
		const korean = "가".repeat(1000);
		expect(estimateTokens({ role: "user", content: korean, timestamp: 0 })).toBe(1000);
		expect(estimateTokens({ role: "user", content: "a".repeat(1000), timestamp: 0 })).toBe(250);
		expect(
			estimateTokens({
				role: "user",
				content: [{ type: "text", text: korean }],
				timestamp: 0,
			}),
		).toBe(1000);
	});
});

describe("verbatim user requests in summaries", () => {
	it("quotes user messages and carries earlier quotes from the previous summary", () => {
		const first = formatUserRequestsSection(undefined, [
			{ role: "user", content: "Fix the login bug", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "Do not touch\nthe API" }], timestamp: 1 },
		]);
		expect(first).toBe('\n\n## User Requests (verbatim)\n- "Fix the login bug"\n- "Do not touch\\nthe API"');

		const previous = `## Goal\nFix login${first}\n\n<read-files>\na.ts\n</read-files>`;
		const second = formatUserRequestsSection(previous, [{ role: "user", content: "Also add a test", timestamp: 2 }]);
		expect(second).toBe(
			'\n\n## User Requests (verbatim)\n- "Fix the login bug"\n- "Do not touch\\nthe API"\n- "Also add a test"',
		);
	});

	it("keeps the first request and the most recent ones within the size limit", () => {
		const messages = Array.from({ length: 40 }, (_, i) => ({
			role: "user" as const,
			content: `request-${i} ${"x".repeat(1000)}`,
			timestamp: i,
		}));
		const section = formatUserRequestsSection(undefined, messages);
		expect(section).toContain('"request-0 ');
		expect(section).toContain('"request-39 ');
		expect(section).toMatch(/- \[\d+ earlier requests omitted\]/);
		expect(section.length).toBeLessThan(13_000);
		// The omission marker is not itself carried as a quote.
		const again = formatUserRequestsSection(`## Goal\nx${section}`, []);
		expect(again.match(/earlier requests omitted/g)?.length ?? 0).toBeLessThanOrEqual(1);
		expect(again).toContain('"request-0 ');
		expect(again).toContain('"request-39 ');
	});

	it("clips very long requests", () => {
		const section = formatUserRequestsSection(undefined, [{ role: "user", content: "y".repeat(5000), timestamp: 0 }]);
		expect(section).toContain(" [...]");
		expect(section.length).toBeLessThan(1600);
	});

	it("strips a model-written section without touching the following sections or the split-turn context", () => {
		expect(stripUserRequests('## Goal\nG\n\n## User Requests (verbatim)\n- "a"\n\n## Next Steps\n1. N')).toBe(
			"## Goal\nG\n\n## Next Steps\n1. N",
		);
		expect(stripUserRequests('## Goal\nG\n\n## User Requests (verbatim)\n- "a"')).toBe("## Goal\nG");
		expect(
			stripUserRequests(
				'## Goal\nG\n\n## User Requests (verbatim)\n- "a"\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\nR',
			),
		).toBe("## Goal\nG\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\nR");
		expect(stripUserRequests("## Goal\nG")).toBe("## Goal\nG");
	});
});

describe("compact() appends verbatim user requests", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
		return {
			firstKeptEntryId: "kept",
			messagesToSummarize: [
				{ role: "user", content: "Rename the config loader, keep the old export", timestamp: 1 },
				{ ...fauxAssistantMessage("Renamed."), timestamp: 2 },
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100_000,
			fileOps: { read: new Set(["src/config.ts"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 100 },
			...overrides,
		};
	}

	it("replaces the model's copy with the code-built section before the file list, across compactions", async () => {
		const harness = await createHarness({ models: [{ id: "requests-faux", contextWindow: 200_000 }] });
		harnesses.push(harness);
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				prompts.push(getMessageText(context.messages.find((message) => message.role === "user")));
				return fauxAssistantMessage('## Goal\nRename loader\n\n## User Requests (verbatim)\n- "paraphrased"');
			},
			(context) => {
				prompts.push(getMessageText(context.messages.find((message) => message.role === "user")));
				return fauxAssistantMessage("## Goal\nRename loader and test it");
			},
		]);

		const first = await compact(preparation(), harness.getModel(), "faux-key");
		expect(prompts[0]).toContain("under 800 words");
		expect(first.summary).not.toContain("paraphrased");
		expect(first.summary).toContain(
			'## User Requests (verbatim)\n- "Rename the config loader, keep the old export"\n\n<read-files>',
		);

		const second = await compact(
			preparation({
				messagesToSummarize: [{ role: "user", content: "Now add a test for it", timestamp: 3 }],
				previousSummary: first.summary.slice(0, first.summary.indexOf("\n\n<read-files>")),
			}),
			harness.getModel(),
			"faux-key",
		);
		expect(prompts[1]).toContain('Do not write a "User Requests (verbatim)" section');
		// The stored quotes are rebuilt by code, not sent back to the model.
		expect(prompts[1]).not.toContain("Rename the config loader, keep the old export");
		expect(second.summary).toContain(
			'## User Requests (verbatim)\n- "Rename the config loader, keep the old export"\n- "Now add a test for it"',
		);
		expect(second.summary.match(/## User Requests \(verbatim\)/g)).toHaveLength(1);
	});
});
