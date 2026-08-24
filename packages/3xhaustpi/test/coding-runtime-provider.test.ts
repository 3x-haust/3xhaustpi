import { describe, expect, it, vi } from "vitest";
import { runProviderTurn, semanticUsage } from "../src/coding-runtime-provider.ts";

describe("provider turn cancellation", () => {
	it("preserves measured cache-write usage", () => {
		const measured = (value: number) => ({ status: "measured" as const, value, source: "provider-usage" as const });

		expect(
			semanticUsage({
				usage: {
					input: measured(10),
					output: measured(20),
					cacheRead: measured(30),
					cacheWrite: measured(40),
				},
			}),
		).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
	});

	it("rejects a pre-aborted signal before invoking the provider operation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled before provider dispatch"));
		const operation = vi.fn(async () => "unexpected");

		await expect(runProviderTurn(controller.signal, operation)).rejects.toThrow(
			/cancelled before provider dispatch/u,
		);

		expect(operation).not.toHaveBeenCalled();
	});
});
