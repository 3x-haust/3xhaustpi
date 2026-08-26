import { describe, expect, it, vi } from "vitest";
import { CacheWarmController, type CacheWarmTimer, cacheWarmDelayMs } from "../src/cache-warm-controller.ts";

function target() {
	return {
		projectRoot: "/tmp/project",
		sessionId: "session_cache",
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		thinkingLevel: "medium" as const,
	};
}

describe("CacheWarmController", () => {
	it("uses provider TTL defaults and an explicit safe-wait override", () => {
		// Given: supported providers and an optional environment override.
		const override = { PI_PROMPT_CACHE_SAFE_WAIT_SECONDS: "90" };

		// When: wake delays are resolved.
		const codex = cacheWarmDelayMs("openai-codex", {});
		const anthropic = cacheWarmDelayMs("anthropic", {});
		const overridden = cacheWarmDelayMs("openai-codex", override);

		// Then: each wake precedes its provider cache expiry.
		expect(codex).toBe(270_000);
		expect(anthropic).toBe(3_300_000);
		expect(overridden).toBe(90_000);
		expect(cacheWarmDelayMs("unsupported", {})).toBeUndefined();
	});

	it("warms an eligible session and reschedules without transcript timing", async () => {
		// Given: an enabled controller with a deterministic timer.
		let now = 1_000;
		let callback: (() => void) | undefined;
		const cancel = vi.fn();
		const warm = vi.fn(async () => ({
			durationMs: 45,
			contextTokens: 12_000,
			usage: { input: 1, output: 1, cacheRead: 11_999, cacheWrite: 0 },
			estimatedSavingsUsd: 0.08,
		}));
		const controller = new CacheWarmController({
			enabled: true,
			clock: () => now,
			delayFor: () => 500,
			schedule: (_delayMs, task): CacheWarmTimer => {
				callback = task;
				return { cancel };
			},
			warm,
		});

		// When: a completed conversation becomes eligible and its exact timer fires.
		controller.setTarget(target());
		expect(controller.snapshot()).toMatchObject({ state: "scheduled", nextWakeAt: 1_500 });
		now = 1_500;
		callback?.();
		await controller.waitForIdle();

		// Then: one silent warm request is measured and the next wake is scheduled.
		expect(warm).toHaveBeenCalledOnce();
		expect(controller.snapshot()).toMatchObject({
			enabled: true,
			state: "fresh",
			iteration: 1,
			nextWakeAt: 2_000,
			estimatedSavingsUsd: 0.08,
			contextTokens: 12_000,
		});
	});

	it("cancels future and in-flight wakes when disabled", async () => {
		// Given: a scheduled eligible wake.
		let callback: (() => void) | undefined;
		const cancel = vi.fn();
		const warm = vi.fn(async (_target, signal: AbortSignal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			throw signal.reason;
		});
		const controller = new CacheWarmController({
			enabled: true,
			clock: () => 0,
			delayFor: () => 500,
			schedule: (_delayMs, task): CacheWarmTimer => {
				callback = task;
				return { cancel };
			},
			warm,
		});
		controller.setTarget(target());
		controller.setEnabled(false);
		expect(cancel).toHaveBeenCalledOnce();
		controller.setEnabled(true);
		callback?.();

		// When: warming is disabled.
		controller.setEnabled(false);
		await controller.waitForIdle();

		// Then: timers and provider work are cancelled without another schedule.
		expect(warm).toHaveBeenCalledOnce();
		expect(controller.snapshot()).toMatchObject({ enabled: false, state: "off" });
	});

	it("aborts an in-flight wake and clears targets when scope changes", async () => {
		// Given: a wake running for one project scope.
		let callback: (() => void) | undefined;
		let aborted = false;
		const controller = new CacheWarmController({
			enabled: true,
			clock: () => 0,
			delayFor: () => 500,
			schedule: (_delayMs, task): CacheWarmTimer => {
				callback = task;
				return { cancel: () => {} };
			},
			warm: async (_target, signal) => {
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					),
				);
				throw signal.reason;
			},
		});
		controller.setTarget(target());
		callback?.();

		// When: foreground work suspends warming and a new project disables it.
		controller.suspend();
		await controller.waitForIdle();
		controller.reset(false);

		// Then: provider work is aborted and no old target remains scheduled.
		expect(aborted).toBe(true);
		expect(controller.snapshot()).toMatchObject({ enabled: false, state: "off", iteration: 0 });
		controller.setEnabled(true);
		expect(controller.snapshot()).toMatchObject({ enabled: true, state: "waiting" });
	});

	it("rejects late telemetry after the conversation target is cleared", async () => {
		// Given: an active warm request whose provider ignores cancellation.
		let callback: (() => void) | undefined;
		let completeWarm: (() => void) | undefined;
		const controller = new CacheWarmController({
			enabled: true,
			clock: () => 0,
			delayFor: () => 500,
			schedule: (_delayMs, task): CacheWarmTimer => {
				callback = task;
				return { cancel: () => {} };
			},
			warm: async () => {
				await new Promise<void>((resolve) => {
					completeWarm = resolve;
				});
				return {
					durationMs: 1,
					contextTokens: 10_000,
					usage: { input: 1, output: 1, cacheRead: 9_999, cacheWrite: 0 },
					estimatedSavingsUsd: 0.08,
				};
			},
		});
		controller.setTarget(target());
		callback?.();

		// When: the conversation changes before the old provider response settles.
		controller.setTarget(undefined);
		if (!completeWarm) throw new Error("Cache warm request did not start");
		completeWarm();
		await controller.waitForIdle();

		// Then: old-session iteration and savings cannot reappear.
		expect(controller.snapshot()).toEqual({ enabled: true, state: "waiting", iteration: 0 });
	});
});
