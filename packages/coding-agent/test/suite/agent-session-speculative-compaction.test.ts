import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const BODY = "y".repeat(1200); // about 300 tokens

function dumpExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "dump",
		label: "dump",
		description: "Print text.",
		parameters: Type.Object({ n: Type.Number() }),
		execute: async (_id, { n }) => ({ content: [{ type: "text", text: `${n}:${BODY}` }], details: {} }),
	});
}

function contextTokens(context: TranscriptContext): number {
	return Math.ceil(JSON.stringify(context.messages).length / 4);
}

/** Main requests call `dump` `calls` times, then answer; summary requests return a summary. */
function scriptStream(harness: Harness, calls: number, log: string[]): void {
	let mainRequests = 0;
	harness.session.agent.streamFunction = (model, context) => {
		const isSummary = JSON.stringify(context.messages.at(-1)).includes("Pause the task");
		const stream = createAssistantMessageEventStream();
		let message: AssistantMessage;
		if (isSummary) {
			log.push("summary");
			message = { ...fauxAssistantMessage("## Goal\nspeculative summary"), stopReason: "stop" };
		} else {
			mainRequests++;
			message =
				mainRequests <= calls
					? fauxAssistantMessage([fauxToolCall("dump", { n: mainRequests })], { stopReason: "toolUse" })
					: fauxAssistantMessage("done");
		}
		const total = contextTokens(context);
		const final: AssistantMessage = {
			...message,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: total,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: total,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		queueMicrotask(() =>
			stream.push({ type: "done", reason: final.stopReason === "toolUse" ? "toolUse" : "stop", message: final }),
		);
		return stream;
	};
}

describe("speculative compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts the summary before the threshold and reuses it at the threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 6000, maxTokens: 100 }],
			extensionFactories: [dumpExtension],
			settings: {
				compaction: { reserveTokens: 0, keepRecentTokens: 600, maxContextTokens: 0 },
				contextPruning: { enabled: false },
			},
		});
		harnesses.push(harness);
		const log: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") log.push("compaction_start");
		});
		scriptStream(harness, 25, log);

		await harness.session.prompt("dump a lot");

		const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions.length).toBeGreaterThanOrEqual(1);
		expect(compactions[0]?.type === "compaction" && compactions[0].summary).toContain("speculative summary");
		// Each compaction used the summary started in the background instead of requesting another.
		// Without reuse every compaction would cost two summary requests. One more speculative
		// summary may start near the end of the run and go unused.
		const summaries = log.filter((entry) => entry === "summary").length;
		expect(compactions.length).toBeGreaterThanOrEqual(2);
		expect(summaries).toBeLessThanOrEqual(compactions.length + 1);
		expect(log.filter((entry) => entry === "compaction_start")).toHaveLength(compactions.length);
		// The background summary's request usage is stored on the entry that used it.
		for (const entry of compactions) {
			const details = entry.type === "compaction" ? (entry.details as { usageRequests?: unknown[] }) : undefined;
			expect(details?.usageRequests?.length).toBe(1);
		}
	});

	it("stops waiting for the background summary when compaction is aborted", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 6000, maxTokens: 100 }],
			extensionFactories: [dumpExtension],
			settings: {
				compaction: { reserveTokens: 0, keepRecentTokens: 600, maxContextTokens: 0 },
				contextPruning: { enabled: false },
			},
		});
		harnesses.push(harness);
		const scripted = harness.session.agent.streamFunction;
		scriptStream(harness, 25, []);
		const main = harness.session.agent.streamFunction;
		expect(main).not.toBe(scripted);
		// Summaries never answer on their own; they end only when their request is aborted.
		const summarySignals: AbortSignal[] = [];
		harness.session.agent.streamFunction = (model, context, options) => {
			if (!JSON.stringify(context.messages.at(-1)).includes("Pause the task")) return main(model, context, options);
			const stream = createAssistantMessageEventStream();
			const signal = options?.signal;
			if (signal) summarySignals.push(signal);
			signal?.addEventListener(
				"abort",
				() => {
					const error = { ...fauxAssistantMessage("", { stopReason: "aborted" }), api: model.api };
					stream.push({ type: "error", reason: "aborted", error });
				},
				{ once: true },
			);
			return stream;
		};
		// Esc on every threshold compaction. Before the fix the first one waited for the background
		// summary forever. Overflow recovery later summarizes without the cache and completes.
		const ends: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start" && event.reason === "threshold") {
				setTimeout(() => harness.session.abortCompaction(), 0);
			}
			if (event.type === "compaction_end" && event.reason === "threshold") ends.push(event.aborted);
		});

		await harness.session.prompt("dump a lot");

		expect(ends.length).toBeGreaterThanOrEqual(1);
		expect(ends.every((aborted) => aborted)).toBe(true);
		expect(summarySignals.length).toBeGreaterThanOrEqual(1);
		expect(summarySignals.every((signal) => signal.aborted)).toBe(true);
	});
});
