export interface CacheWarmTarget {
	readonly projectRoot: string;
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly accountId?: string;
	readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface CacheWarmUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface CacheWarmResult {
	readonly durationMs: number;
	readonly contextTokens: number;
	readonly usage: CacheWarmUsage;
	readonly estimatedSavingsUsd?: number;
}

export type CacheWarmState = "off" | "waiting" | "scheduled" | "warming" | "fresh" | "retry" | "unavailable";

export interface CacheWarmSnapshot {
	readonly enabled: boolean;
	readonly state: CacheWarmState;
	readonly iteration: number;
	readonly nextWakeAt?: number;
	readonly contextTokens?: number;
	readonly estimatedSavingsUsd?: number;
	readonly lastDurationMs?: number;
	readonly lastError?: string;
}

export interface CacheWarmTimer {
	cancel(): void;
}

interface CacheWarmControllerOptions {
	readonly enabled?: boolean;
	readonly warm: (target: CacheWarmTarget, signal: AbortSignal) => Promise<CacheWarmResult>;
	readonly clock?: () => number;
	readonly delayFor?: (provider: string) => number | undefined;
	readonly schedule?: (delayMs: number, task: () => void) => CacheWarmTimer;
	readonly onChange?: (snapshot: CacheWarmSnapshot) => void;
}

const DEFAULT_DELAYS_MS: Readonly<Record<string, number>> = {
	"openai-codex": 270_000,
	anthropic: 3_300_000,
	openai: 82_800_000,
};

function positiveSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function cacheWarmDelayMs(
	provider: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
	const override = positiveSeconds(env.X3HAUSTPI_CACHE_WARM_SECONDS ?? env.PI_PROMPT_CACHE_SAFE_WAIT_SECONDS);
	if (override !== undefined) return override * 1_000;
	return DEFAULT_DELAYS_MS[provider];
}

function defaultSchedule(delayMs: number, task: () => void): CacheWarmTimer {
	const timer = setTimeout(task, delayMs);
	timer.unref?.();
	return { cancel: () => clearTimeout(timer) };
}

export class CacheWarmController {
	private readonly warm: CacheWarmControllerOptions["warm"];
	private readonly clock: () => number;
	private readonly delayFor: (provider: string) => number | undefined;
	private readonly schedule: (delayMs: number, task: () => void) => CacheWarmTimer;
	private readonly onChange: ((snapshot: CacheWarmSnapshot) => void) | undefined;
	private enabled: boolean;
	private state: CacheWarmState;
	private iteration = 0;
	private target: CacheWarmTarget | undefined;
	private timer: CacheWarmTimer | undefined;
	private activeController: AbortController | undefined;
	private activePromise: Promise<void> | undefined;
	private targetGeneration = 0;
	private suspended = false;
	private latest: Omit<CacheWarmSnapshot, "enabled" | "state" | "iteration" | "nextWakeAt"> = {};
	private nextWakeAt: number | undefined;

	constructor(options: CacheWarmControllerOptions) {
		this.warm = options.warm;
		this.clock = options.clock ?? Date.now;
		this.delayFor = options.delayFor ?? ((provider) => cacheWarmDelayMs(provider));
		this.schedule = options.schedule ?? defaultSchedule;
		this.onChange = options.onChange;
		this.enabled = options.enabled ?? false;
		this.state = this.enabled ? "waiting" : "off";
	}

	snapshot(): CacheWarmSnapshot {
		return {
			enabled: this.enabled,
			state: this.state,
			iteration: this.iteration,
			...(this.nextWakeAt !== undefined ? { nextWakeAt: this.nextWakeAt } : {}),
			...this.latest,
		};
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		if (!enabled) {
			this.cancelScheduled();
			this.activeController?.abort(new Error("Cache warming disabled"));
			this.state = "off";
			this.emit();
			return;
		}
		this.scheduleNext("scheduled");
	}

	setTarget(target: CacheWarmTarget | undefined): void {
		if (!this.sameTarget(target)) {
			this.targetGeneration++;
			this.activeController?.abort(new Error("Cache warming conversation changed"));
			this.iteration = 0;
			this.latest = {};
		}
		this.target = target;
		if (this.enabled) this.scheduleNext("scheduled");
	}

	reset(enabled: boolean): void {
		this.cancelScheduled();
		this.activeController?.abort(new Error("Cache warming scope changed"));
		this.enabled = enabled;
		this.targetGeneration++;
		this.target = undefined;
		this.iteration = 0;
		this.suspended = false;
		this.latest = {};
		this.state = enabled ? "waiting" : "off";
		this.emit();
	}

	suspend(): void {
		this.suspended = true;
		this.cancelScheduled();
		this.activeController?.abort(new Error("Cache warming suspended"));
		if (this.enabled) {
			this.state = "waiting";
			this.emit();
		}
	}

	resume(): void {
		this.suspended = false;
		if (this.enabled) this.scheduleNext("scheduled");
	}

	async waitForIdle(): Promise<void> {
		await this.activePromise;
	}

	async close(): Promise<void> {
		this.setEnabled(false);
		await this.waitForIdle();
	}

	private scheduleNext(state: "scheduled" | "fresh" | "retry"): void {
		this.cancelScheduled();
		if (!this.enabled || this.suspended) {
			this.state = this.enabled ? "waiting" : "off";
			this.emit();
			return;
		}
		if (!this.target) {
			this.state = "waiting";
			this.emit();
			return;
		}
		const delayMs = this.delayFor(this.target.provider);
		if (delayMs === undefined) {
			this.state = "unavailable";
			this.emit();
			return;
		}
		this.nextWakeAt = this.clock() + delayMs;
		this.state = state;
		this.timer = this.schedule(delayMs, () => {
			this.timer = undefined;
			this.nextWakeAt = undefined;
			this.activePromise = this.runWake();
		});
		this.emit();
	}

	private async runWake(): Promise<void> {
		const target = this.target;
		if (!this.enabled || this.suspended || !target) return;
		const targetGeneration = this.targetGeneration;
		const controller = new AbortController();
		this.activeController = controller;
		this.state = "warming";
		this.emit();
		try {
			const result = await this.warm(target, controller.signal);
			if (!this.enabled || this.suspended || controller.signal.aborted || targetGeneration !== this.targetGeneration)
				return;
			if (result.usage.cacheRead <= 0 || (result.estimatedSavingsUsd ?? 0) < 0.01) {
				this.latest = {
					contextTokens: result.contextTokens,
					lastDurationMs: result.durationMs,
					lastError: result.usage.cacheRead <= 0 ? "Cache miss" : "Projected savings below $0.01",
				};
				this.state = "unavailable";
				this.emit();
				return;
			}
			this.iteration++;
			this.latest = {
				contextTokens: result.contextTokens,
				lastDurationMs: result.durationMs,
				...(result.estimatedSavingsUsd !== undefined ? { estimatedSavingsUsd: result.estimatedSavingsUsd } : {}),
			};
			this.scheduleNext("fresh");
		} catch (cause) {
			if (!this.enabled || controller.signal.aborted) return;
			this.latest = { lastError: cause instanceof Error ? cause.message : String(cause) };
			this.scheduleNext("retry");
		} finally {
			if (this.activeController === controller) this.activeController = undefined;
		}
	}

	private cancelScheduled(): void {
		this.timer?.cancel();
		this.timer = undefined;
		this.nextWakeAt = undefined;
	}

	private sameTarget(target: CacheWarmTarget | undefined): boolean {
		if (!this.target || !target) return this.target === target;
		return (
			this.target.projectRoot === target.projectRoot &&
			this.target.sessionId === target.sessionId &&
			this.target.provider === target.provider &&
			this.target.model === target.model &&
			this.target.accountId === target.accountId &&
			this.target.thinkingLevel === target.thinkingLevel
		);
	}

	private emit(): void {
		this.onChange?.(this.snapshot());
	}
}
