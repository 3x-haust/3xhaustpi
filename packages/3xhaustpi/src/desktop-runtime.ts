import type {
	DesktopAccessibilityObservation,
	DesktopActionResult,
	DesktopApplicationList,
	DesktopApplicationTarget,
	DesktopComputerAction,
	DesktopHelperRuntime,
} from "./desktop-runtime-contracts.ts";
import { resolveDesktopHelper } from "./desktop-runtime-platform-hosts.ts";
import { requestDesktopHelper } from "./desktop-runtime-transport.ts";
import {
	assertObject,
	desktopDigest,
	observationDigest,
	parseApplications,
	parseObservation,
	validateAction,
	validateTarget,
} from "./desktop-runtime-validation.ts";

export type {
	DesktopAccessibilityElement,
	DesktopAccessibilityObservation,
	DesktopAccessibilityPlatform,
	DesktopAccessibilityRole,
	DesktopActionResult,
	DesktopApplication,
	DesktopApplicationTarget,
	DesktopComputerAction,
	DesktopHelperRuntime,
} from "./desktop-runtime-contracts.ts";

export function desktopComputerUseStatus(): {
	readonly platform: NodeJS.Platform;
	readonly available: boolean;
	readonly helper: string;
} {
	const runtime = resolveDesktopHelper();
	return {
		platform: process.platform,
		available: runtime !== undefined,
		helper: runtime?.helper ?? "unavailable",
	};
}

export class DesktopAccessibilityHost {
	readonly #timeoutMs: number;
	readonly #runtime: DesktopHelperRuntime | undefined;

	constructor(options: { readonly timeoutMs?: number; readonly helperRuntime?: DesktopHelperRuntime } = {}) {
		this.#timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 10_000, 30_000));
		this.#runtime = options.helperRuntime ?? resolveDesktopHelper();
	}

	async listApplications(signal?: AbortSignal): Promise<DesktopApplicationList> {
		const runtime = this.#requireRuntime();
		return parseApplications(await this.#request({ operation: "list" }, signal), runtime.platform);
	}

	async observe(
		targetInput: DesktopApplicationTarget,
		options: { readonly signal?: AbortSignal; readonly maxElements?: number } = {},
	): Promise<DesktopAccessibilityObservation> {
		const target = validateTarget(targetInput);
		const started = performance.now();
		const internal = parseObservation(
			await this.#request(
				{
					operation: "observe",
					target,
					maxElements: Math.max(1, Math.min(options.maxElements ?? 512, 512)),
				},
				options.signal,
			),
		);
		const currentDigest = observationDigest(internal);
		return {
			application: internal.application,
			digest: currentDigest,
			capturedAt: new Date().toISOString(),
			durationMs: performance.now() - started,
			elements: internal.elements.map(({ role: elementRole, name }) => ({ role: elementRole, name })),
		};
	}

	async act(
		targetInput: DesktopApplicationTarget,
		actionInput: DesktopComputerAction,
		options: { readonly signal?: AbortSignal; readonly approvedCoordinateDigest?: string } = {},
	): Promise<DesktopActionResult> {
		const target = validateTarget(targetInput);
		const action = validateAction(actionInput);
		const started = performance.now();
		const internal = parseObservation(
			await this.#request({ operation: "observe", target, maxElements: 512 }, options.signal),
		);
		const currentDigest = observationDigest(internal);
		if (currentDigest !== action.target.observationDigest) {
			throw new Error("Desktop Computer Use observation is stale; observe accessibility again.");
		}
		const matches = internal.elements.filter(
			(element) => element.role === action.target.role && element.name === action.target.name,
		);
		let path: readonly number[] | undefined;
		let coordinateFallback = false;
		if (matches.length > 1) throw new Error("Desktop Computer Use semantic target is ambiguous.");
		if (matches.length === 1) {
			path = matches[0]?.path;
		} else if (action.action === "click" && action.coordinates) {
			const expectedApproval = desktopDigest({
				scope: "desktop-coordinate-fallback",
				pid: target.pid,
				observationDigest: currentDigest,
				coordinates: action.coordinates,
				button: action.button,
			});
			if (!options.approvedCoordinateDigest || options.approvedCoordinateDigest !== expectedApproval) {
				throw new Error("Desktop coordinate fallback requires a matching host-issued approval.");
			}
			coordinateFallback = true;
		} else {
			throw new Error("Desktop Computer Use semantic target is unavailable.");
		}
		const result = await this.#request(
			{
				operation: "perform",
				target,
				action,
				...(path ? { path } : {}),
				expected: action.target,
				coordinateFallback,
			},
			options.signal,
		);
		assertObject(result, "desktop action result");
		if (result.method !== "accessibility" && result.method !== "coordinates") {
			throw new Error("desktop action result method is invalid");
		}
		return {
			method: result.method,
			digest: desktopDigest({ target, observationDigest: currentDigest, action, method: result.method }),
			completedAt: new Date().toISOString(),
			durationMs: performance.now() - started,
		};
	}

	#requireRuntime(): DesktopHelperRuntime {
		if (!this.#runtime) throw new Error(`Desktop Computer Use is unavailable on ${process.platform}.`);
		return this.#runtime;
	}

	async #request(request: unknown, signal?: AbortSignal): Promise<unknown> {
		return await requestDesktopHelper(this.#requireRuntime(), this.#timeoutMs, request, signal);
	}
}
