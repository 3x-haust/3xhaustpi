import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const BODY = "x".repeat(2400);

function bigOutputExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "dump",
		label: "dump",
		description: "Print a large text.",
		parameters: Type.Object({ n: Type.Number() }),
		execute: async (_id, { n }) => ({ content: [{ type: "text", text: `${n}:${BODY}` }], details: {} }),
	});
}

async function runDumps(harness: Harness, count: number): Promise<void> {
	harness.setResponses([
		...Array.from({ length: count }, (_, n) =>
			fauxAssistantMessage([fauxToolCall("dump", { n })], { stopReason: "toolUse" }),
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("dump files");
}

function toolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("AgentSession context pruning", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("clears old large tool results in one batch after the cache expired", async () => {
		const harness = await createHarness({
			extensionFactories: [bigOutputExtension],
			settings: { contextPruning: { protectRecentTokens: 1300, minSavingsTokens: 1000 } },
		});
		harnesses.push(harness);
		await runDumps(harness, 6);
		expect(toolResults(harness).every((result) => getMessageText(result).includes(BODY))).toBe(true);

		const later = Date.now() + 2 * 60 * 60_000;
		vi.spyOn(Date, "now").mockReturnValue(later);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("next");

		const texts = toolResults(harness).map(getMessageText);
		const cleared = texts.filter((text) => text.startsWith("[Old dump result cleared"));
		expect(cleared.length).toBeGreaterThanOrEqual(3);
		// The newest results stay intact.
		expect(texts.at(-1)).toContain(BODY);
		// The pointer names a file holding the original text.
		const path = /saved at (\S+);/.exec(cleared[0])?.[1];
		expect(path && readFileSync(path, "utf8")).toBe(`0:${BODY}`);
		// Edits are persisted, so later requests keep the same shortened prefix.
		const edits = harness.sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
		expect(edits).toHaveLength(cleared.length);
	});

	it("keeps results while the cache is warm and context is far from compaction", async () => {
		const harness = await createHarness({
			extensionFactories: [bigOutputExtension],
			settings: { contextPruning: { protectRecentTokens: 1300, minSavingsTokens: 1000 } },
		});
		harnesses.push(harness);
		await runDumps(harness, 6);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("next");

		expect(toolResults(harness).every((result) => getMessageText(result).includes(BODY))).toBe(true);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_edit")).toBe(false);
	});

	it("counts a recent cache warm-up as keeping the cache warm", async () => {
		const harness = await createHarness({
			extensionFactories: [bigOutputExtension],
			settings: { contextPruning: { protectRecentTokens: 1300, minSavingsTokens: 1000 } },
		});
		harnesses.push(harness);
		await runDumps(harness, 6);

		const later = Date.now() + 2 * 60 * 60_000;
		const model = harness.getModel();
		const warmed = harness.sessionManager.appendUsage("cache_warm", model.provider, model.id, {
			input: 0,
			output: 1,
			cacheRead: 1000,
			cacheWrite: 0,
			totalTokens: 1001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		// The last answer is two hours old, but the cache was refreshed a minute ago.
		warmed.timestamp = new Date(later - 60_000).toISOString();
		vi.spyOn(Date, "now").mockReturnValue(later);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("next");

		expect(toolResults(harness).every((result) => getMessageText(result).includes(BODY))).toBe(true);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_edit")).toBe(false);
	});

	it("does nothing when disabled", async () => {
		const harness = await createHarness({
			extensionFactories: [bigOutputExtension],
			settings: { contextPruning: { enabled: false, protectRecentTokens: 1300, minSavingsTokens: 1000 } },
		});
		harnesses.push(harness);
		await runDumps(harness, 6);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("next");

		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_edit")).toBe(false);
	});
});
