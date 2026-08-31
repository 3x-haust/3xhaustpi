import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSystemPromptResource } from "./resource-loader-contracts.ts";

export const MAX_GLOBAL_SYSTEM_PROMPT_BYTES = 16_384;
const DEFAULT_BUILTIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../resources");
const DEFAULT_USER_SYSTEM_PROMPT = "No additional user-global instructions are configured.\n";

export interface GlobalSystemPromptLayers {
	readonly service: GlobalSystemPromptResource;
	readonly user: GlobalSystemPromptResource | undefined;
}

export class GlobalSystemPromptError extends Error {
	readonly sourcePath: string;

	constructor(sourcePath: string, message: string, options?: ErrorOptions) {
		super(`Global system prompt "${sourcePath}" ${message}`, options);
		this.name = "GlobalSystemPromptError";
		this.sourcePath = sourcePath;
	}
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function loadPromptFile(
	sourcePath: string,
	scope: GlobalSystemPromptResource["scope"],
): GlobalSystemPromptResource | undefined {
	let descriptor: number | undefined;
	try {
		let pathStats: ReturnType<typeof lstatSync>;
		try {
			pathStats = lstatSync(sourcePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (pathStats.isSymbolicLink()) {
			throw new GlobalSystemPromptError(sourcePath, "must not be a symbolic link");
		}
		if (!pathStats.isFile()) {
			throw new GlobalSystemPromptError(sourcePath, "must be a regular file");
		}
		if (pathStats.size > MAX_GLOBAL_SYSTEM_PROMPT_BYTES) {
			throw new GlobalSystemPromptError(
				sourcePath,
				`must not exceed ${MAX_GLOBAL_SYSTEM_PROMPT_BYTES.toLocaleString("en-US")} bytes`,
			);
		}

		const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
		descriptor = openSync(sourcePath, constants.O_RDONLY | noFollow);
		const descriptorStats = fstatSync(descriptor);
		if (!descriptorStats.isFile()) {
			throw new GlobalSystemPromptError(sourcePath, "must be a regular file");
		}
		const bytes = readFileSync(descriptor);
		if (bytes.byteLength > MAX_GLOBAL_SYSTEM_PROMPT_BYTES) {
			throw new GlobalSystemPromptError(
				sourcePath,
				`must not exceed ${MAX_GLOBAL_SYSTEM_PROMPT_BYTES.toLocaleString("en-US")} bytes`,
			);
		}

		let instructions: string;
		try {
			instructions = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new GlobalSystemPromptError(sourcePath, "must contain valid UTF-8", { cause: error });
		}
		if (instructions.includes("\u0000")) {
			throw new GlobalSystemPromptError(sourcePath, "must not contain NUL");
		}
		if (instructions.trim().length === 0) return undefined;
		return { instructions, scope, sourcePath, sha256: sha256(bytes) };
	} catch (error) {
		if (error instanceof GlobalSystemPromptError) throw error;
		throw new GlobalSystemPromptError(sourcePath, "could not be read", { cause: error });
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function loadGlobalSystemPrompt(
	userRoot: string,
	builtinRoot = DEFAULT_BUILTIN_ROOT,
): GlobalSystemPromptResource | undefined {
	const layers = loadGlobalSystemPromptLayers(userRoot, builtinRoot);
	return layers.user ?? layers.service;
}

export function loadGlobalSystemPromptLayers(
	userRoot: string,
	builtinRoot = DEFAULT_BUILTIN_ROOT,
): GlobalSystemPromptLayers {
	const bundledPath = join(builtinRoot, "default-system-prompt.md");
	const service = loadPromptFile(bundledPath, "builtin");
	if (!service) throw new GlobalSystemPromptError(bundledPath, "is missing or blank");
	return {
		service,
		user: loadPromptFile(join(userRoot, "system-prompt.md"), "user"),
	};
}

export function initializeGlobalSystemPrompt(
	userRoot: string,
	builtinRoot = DEFAULT_BUILTIN_ROOT,
): GlobalSystemPromptResource {
	const bundledPath = join(builtinRoot, "default-system-prompt.md");
	const bundled = loadPromptFile(bundledPath, "builtin");
	if (!bundled) throw new GlobalSystemPromptError(bundledPath, "is missing or blank");
	const sourcePath = join(userRoot, "system-prompt.md");
	mkdirSync(userRoot, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(sourcePath, DEFAULT_USER_SYSTEM_PROMPT, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new GlobalSystemPromptError(sourcePath, "already exists and will not be overwritten");
		}
		rmSync(sourcePath, { force: true });
		throw new GlobalSystemPromptError(sourcePath, "could not be initialized", { cause: error });
	}
	const initialized = loadPromptFile(sourcePath, "user");
	if (!initialized) throw new GlobalSystemPromptError(sourcePath, "could not be initialized");
	return initialized;
}
