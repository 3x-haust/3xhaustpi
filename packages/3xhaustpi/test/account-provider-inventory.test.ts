import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.ts";
import { collectProviderStatuses, createProviderRuntime } from "../src/provider-runtime.ts";

describe("Pi provider account inventory", () => {
	it("derives every provider and login method from the Pi registry", async () => {
		const runtime = createProviderRuntime();
		const statuses = await collectProviderStatuses(runtime);

		expect(statuses).toHaveLength(runtime.getProviders().length);
		expect(statuses.length).toBeGreaterThan(30);
		expect(statuses.map(({ id }) => id)).toEqual(runtime.getProviders().map(({ id }) => id));
		expect(statuses.find(({ id }) => id === "openai-codex")?.authMethods).toEqual([
			expect.objectContaining({ type: "oauth", interactive: true }),
		]);
		expect(statuses.find(({ id }) => id === "anthropic")?.authMethods).toEqual([
			expect.objectContaining({ type: "oauth", interactive: true }),
			expect.objectContaining({ type: "api_key", interactive: true }),
		]);
		expect(statuses.find(({ id }) => id === "openrouter")?.modelCount).toBeGreaterThan(300);
	});

	it("parses an explicit OAuth or API-key login method", () => {
		expect(parseCliArgs(["account", "add", "anthropic", "oauth"])).toEqual({
			kind: "account-add",
			provider: "anthropic",
			authType: "oauth",
		});
		expect(parseCliArgs(["account", "add", "anthropic", "api-key"])).toEqual({
			kind: "account-add",
			provider: "anthropic",
			authType: "api_key",
		});
	});
});
