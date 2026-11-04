import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prefixCacheKey } from "../src/core/prompt-cache-key.ts";

const tool = (name: string, description = `${name} tool`) => ({
	name,
	description,
	parameters: Type.Object({ path: Type.String() }),
});

describe("prefixCacheKey", () => {
	it("is stable for the same system prompt and tools, regardless of messages", () => {
		const a = prefixCacheKey({ systemPrompt: "sys", tools: [tool("read"), tool("bash")] });
		const b = prefixCacheKey({ systemPrompt: "sys", tools: [tool("read"), tool("bash")] });

		expect(a).toMatch(/^pfx-[0-9a-f]{40}$/);
		expect(b).toBe(a);
	});

	it("changes when the system prompt, a tool definition or the tool order changes", () => {
		const base = prefixCacheKey({ systemPrompt: "sys", tools: [tool("read"), tool("bash")] });

		expect(prefixCacheKey({ systemPrompt: "sys2", tools: [tool("read"), tool("bash")] })).not.toBe(base);
		expect(prefixCacheKey({ systemPrompt: "sys", tools: [tool("read", "changed"), tool("bash")] })).not.toBe(base);
		expect(prefixCacheKey({ systemPrompt: "sys", tools: [tool("bash"), tool("read")] })).not.toBe(base);
	});

	it("keeps the boundary between system prompt and tools unambiguous", () => {
		expect(prefixCacheKey({ systemPrompt: "a", tools: [] })).not.toBe(
			prefixCacheKey({ systemPrompt: "", tools: [] }),
		);
	});

	it("returns undefined without a system prompt or tools", () => {
		expect(prefixCacheKey({})).toBeUndefined();
		expect(prefixCacheKey({ systemPrompt: "", tools: [] })).toBeUndefined();
	});
});
