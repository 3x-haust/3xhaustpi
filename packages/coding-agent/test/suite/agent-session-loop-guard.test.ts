import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { formatLoopWarning, LoopGuard } from "../../src/core/loop-guard.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("LoopGuard", () => {
	it("counts identical calls with identical results inside the window", () => {
		const guard = new LoopGuard();
		expect(guard.record("bash", { command: "npm test" }, "FAIL")).toBe(1);
		expect(guard.record("bash", { command: "npm test" }, "FAIL")).toBe(2);
		expect(guard.record("bash", { command: "npm test" }, "PASS")).toBe(1);
		expect(guard.record("bash", { command: "npm run build" }, "FAIL")).toBe(1);
		expect(guard.record("bash", { command: "npm test" }, "FAIL")).toBe(3);
	});

	it("forgets calls that left the window", () => {
		const guard = new LoopGuard();
		guard.record("read", { path: "a" }, "x");
		guard.record("read", { path: "a" }, "x");
		for (let i = 0; i < 12; i++) guard.record("read", { path: `other-${i}` }, "y");
		expect(guard.record("read", { path: "a" }, "x")).toBe(1);
	});

	it("warns from the third repeat on", () => {
		expect(formatLoopWarning("bash", 2)).toBeUndefined();
		expect(formatLoopWarning("bash", 3)).toContain("same result 3 times");
	});
});

describe("AgentSession loop guard", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("appends a warning to the third identical tool result the model sees", async () => {
		const failing: AgentTool = {
			name: "check",
			label: "check",
			description: "Run the check",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "1 test failed" }], details: {} }),
		};
		const harness = await createHarness({ tools: [failing], initialActiveToolNames: ["check"] });
		harnesses.push(harness);
		const call = () => fauxAssistantMessage(fauxToolCall("check", {}), { stopReason: "toolUse" });
		harness.setResponses([call(), call(), call(), fauxAssistantMessage("giving up")]);

		await harness.session.prompt("make the check pass");

		const results = harness.session.messages.filter((message) => message.role === "toolResult").map(getMessageText);
		expect(results).toHaveLength(3);
		expect(results[0]).not.toContain("Repeated call");
		expect(results[1]).not.toContain("Repeated call");
		expect(results[2]).toContain("1 test failed");
		expect(results[2]).toContain("[Repeated call: this exact check call returned the same result 3 times");
	});
});
