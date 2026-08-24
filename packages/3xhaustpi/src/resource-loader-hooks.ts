import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { HookEvent, ObserverHook } from "./resource-loader-contracts.ts";

interface HookManifest {
	readonly schemaVersion: 1;
	readonly hooks: readonly {
		readonly id: string;
		readonly event: HookEvent;
		readonly command: string;
		readonly args?: readonly string[];
		readonly enabled?: boolean;
	}[];
}

const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const HOOK_EVENTS = new Set<HookEvent>([
	"session.started",
	"model.completed",
	"capability.started",
	"capability.completed",
	"patch.proposed",
	"patch.decision",
	"diagnostics.completed",
	"assistant.message",
	"session.completed",
	"session.failed",
]);

function assertId(value: string, label: string): void {
	if (!RESOURCE_ID.test(value)) throw new Error(`${label} has an invalid id: ${value}`);
}

function assertRegularFile(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) throw new Error(`Resource must not be a symbolic link: ${path}`);
	if (!info.isFile()) throw new Error(`Resource must be a regular file: ${path}`);
}

export function parseHookManifest(path: string, scope: "user" | "project"): readonly ObserverHook[] {
	if (!existsSync(path)) return [];
	assertRegularFile(path);
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Hook manifest must be an object: ${path}`);
	}
	const candidate = parsed as Partial<HookManifest>;
	if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.hooks)) {
		throw new Error(`Hook manifest schema is unsupported: ${path}`);
	}
	return candidate.hooks
		.filter((hook) => hook.enabled !== false)
		.map((hook) => {
			if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
				throw new Error(`Hook entry must be an object: ${path}`);
			}
			if (typeof hook.id !== "string") throw new Error(`Hook id must be a string: ${path}`);
			assertId(hook.id, "Hook");
			if (typeof hook.event !== "string" || !HOOK_EVENTS.has(hook.event as HookEvent)) {
				throw new Error(`Hook event is unsupported: ${String(hook.event)}`);
			}
			if (typeof hook.command !== "string" || !isAbsolute(hook.command)) {
				throw new Error(`Hook command must be absolute: ${hook.id}`);
			}
			if (!Array.isArray(hook.args) && hook.args !== undefined)
				throw new Error(`Hook args must be an array: ${hook.id}`);
			const args = hook.args ?? [];
			if (args.some((arg: unknown) => typeof arg !== "string")) {
				throw new Error(`Hook args must be strings: ${hook.id}`);
			}
			return {
				id: hook.id,
				event: hook.event as HookEvent,
				command: hook.command,
				args,
				scope,
				sourcePath: path,
			};
		});
}
