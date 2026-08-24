import { describe, expect, it, vi } from "vitest";
import { createDelegateTool } from "../src/agent-delegate-tool.ts";

describe("read-only delegate agent tool", () => {
	it("returns the delegated result with stable call identity", async () => {
		const delegate = vi.fn(async () => "review complete");
		const tool = createDelegateTool({ delegate });

		const result = await Reflect.apply(tool.execute, tool, [
			"call_delegate",
			{ objective: "Review authentication flow" },
			undefined,
			undefined,
			Object.create(null),
		]);

		expect(tool).toMatchObject({ name: "delegate", executionMode: "parallel" });
		expect(delegate).toHaveBeenCalledWith({
			workId: "call_delegate",
			objective: "Review authentication flow",
		});
		expect(result).toMatchObject({
			content: [{ type: "text", text: "review complete" }],
		});
	});

	it("rejects empty delegation objectives at the boundary", async () => {
		const tool = createDelegateTool({ delegate: async () => "unused" });
		await expect(
			Reflect.apply(tool.execute, tool, [
				"call_delegate",
				{ objective: "   " },
				undefined,
				undefined,
				Object.create(null),
			]),
		).rejects.toThrow(/objective/u);
	});
});
