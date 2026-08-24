import { createHash } from "node:crypto";
import type {
	DesktopAccessibilityPlatform,
	DesktopAccessibilityRole,
	DesktopApplicationList,
	DesktopApplicationTarget,
	DesktopComputerAction,
	InternalObservation,
} from "./desktop-runtime-contracts.ts";

export const desktopDigest = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const observationDigest = (observation: InternalObservation): string =>
	desktopDigest({
		application: observation.application.pid,
		elements: observation.elements
			.map(({ role: elementRole, name }) => ({ role: elementRole, name }))
			.sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name)),
	});

export function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
}

function text(value: unknown, name: string, maximum = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${name} must be a bounded non-empty string`);
	}
	return value.trim();
}

function integer(value: unknown, name: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} must be a safe integer`);
	return value as number;
}

function role(value: unknown): DesktopAccessibilityRole {
	if (value === "button" || value === "link" || value === "field" || value === "menu-item" || value === "window") {
		return value;
	}
	throw new Error("desktop accessibility role is invalid");
}

export function parseApplications(
	value: unknown,
	expectedPlatform: DesktopAccessibilityPlatform,
): DesktopApplicationList {
	assertObject(value, "desktop application response");
	if (
		value.platform !== expectedPlatform ||
		typeof value.trusted !== "boolean" ||
		!Array.isArray(value.applications)
	) {
		throw new Error("desktop application response is invalid");
	}
	const applications = value.applications.map((entry) => {
		assertObject(entry, "desktop application");
		if (typeof entry.active !== "boolean") throw new Error("desktop application active state is invalid");
		return {
			pid: integer(entry.pid, "desktop application pid", 1),
			name: text(entry.name, "desktop application name"),
			bundleId: text(entry.bundleId, "desktop application bundle id"),
			active: entry.active,
		};
	});
	return { platform: expectedPlatform, trusted: value.trusted, applications };
}

export function parseObservation(value: unknown): InternalObservation {
	assertObject(value, "desktop observation");
	assertObject(value.application, "desktop observation application");
	if (value.trusted !== true || !Array.isArray(value.elements)) throw new Error("desktop observation is invalid");
	const elements = value.elements.map((entry) => {
		assertObject(entry, "desktop accessibility element");
		if (!Array.isArray(entry.path) || entry.path.length < 1 || entry.path.length > 17) {
			throw new Error("desktop accessibility path is invalid");
		}
		const path = entry.path.map((index) => integer(index, "desktop accessibility path index", -2));
		if (path.some((index) => index > 4_096)) throw new Error("desktop accessibility path index is invalid");
		return {
			role: role(entry.role),
			name: text(entry.name, "desktop accessibility name"),
			path,
		};
	});
	return {
		application: {
			pid: integer(value.application.pid, "desktop observation pid", 1),
			name: text(value.application.name, "desktop observation application name"),
			frontmost: Boolean(value.application.frontmost),
		},
		trusted: true,
		elements,
	};
}

export function validateTarget(target: DesktopApplicationTarget): DesktopApplicationTarget {
	return { pid: integer(target.pid, "desktop target pid", 1) };
}

export function validateAction(action: DesktopComputerAction): DesktopComputerAction {
	assertObject(action, "desktop action");
	assertObject(action.target, "desktop action target");
	const target = {
		role: role(action.target.role),
		name: text(action.target.name, "desktop target name"),
		observationDigest: text(action.target.observationDigest, "desktop observation digest", 64),
	};
	if (!/^[a-f0-9]{64}$/iu.test(target.observationDigest)) throw new Error("desktop observation digest is invalid");
	if (action.action === "click") {
		if (action.button !== "left" && action.button !== "right" && action.button !== "middle") {
			throw new Error("desktop click button is invalid");
		}
		const coordinates = action.coordinates
			? {
					x: integer(action.coordinates.x, "desktop click x"),
					y: integer(action.coordinates.y, "desktop click y"),
				}
			: undefined;
		return {
			action: "click",
			target,
			button: action.button,
			...(coordinates ? { coordinates } : {}),
			...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
		};
	}
	if (action.action === "type") {
		return {
			action: "type",
			target,
			text: text(action.text, "desktop input text", 16_384),
			...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
		};
	}
	if (action.action === "key") {
		if (!["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(action.key)) {
			throw new Error("desktop key is invalid");
		}
		return {
			action: "key",
			target,
			key: action.key,
			...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
		};
	}
	if (!Number.isInteger(action.deltaY) || Math.abs(action.deltaY) > 10_000) {
		throw new Error("desktop scroll delta is invalid");
	}
	return {
		action: "scroll",
		target,
		deltaY: action.deltaY,
		...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
	};
}
