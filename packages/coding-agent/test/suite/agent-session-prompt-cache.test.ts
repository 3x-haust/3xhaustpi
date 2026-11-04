import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Stable ${name} tool`,
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
	};
}

describe("AgentSession cache prefix stability with faux provider", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps system and ordered tool bytes stable across turns, clock changes, and prompt rebuilds", async () => {
		const harness = await createHarness({
			tools: [tool("zebra"), tool("alpha")],
			initialActiveToolNames: ["zebra", "alpha"],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const prefixes: string[] = [];
		const toolNames: string[][] = [];
		const respond: FauxResponseFactory = (context) => {
			prefixes.push(JSON.stringify({ system: context.systemPrompt, tools: context.tools }));
			toolNames.push(context.tools?.map((entry) => entry.name) ?? []);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([respond, respond, respond]);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
		await harness.session.prompt("first");
		clock.mockReturnValue(Date.UTC(2026, 0, 2));
		await harness.session.prompt("second");
		harness.session.setActiveToolsByName(["zebra", "alpha"]);
		await harness.session.prompt("third");

		expect(toolNames).toEqual(Array.from({ length: 3 }, () => ["zebra", "alpha"]));
		expect(prefixes).toHaveLength(3);
		expect(new Set(prefixes).size).toBe(1);
		expect(prefixes[0]).not.toMatch(/2026-01-0[12]/);
	});

	it("preserves system and tools after compaction while intentionally replacing the message prefix", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Offline summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const prefixes: string[] = [];
		const firstMessages: string[] = [];
		const respond: FauxResponseFactory = (context) => {
			prefixes.push(JSON.stringify({ system: context.systemPrompt, tools: context.tools }));
			firstMessages.push(JSON.stringify(context.messages[0]));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([respond, respond, respond]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.compact();
		await harness.session.prompt("after compaction");

		expect(prefixes).toHaveLength(3);
		expect(new Set(prefixes).size).toBe(1);
		expect(firstMessages[1]).toBe(firstMessages[0]);
		expect(firstMessages[2]).not.toBe(firstMessages[0]);
		expect(firstMessages[2]).toContain("Offline summary");
	});
});
