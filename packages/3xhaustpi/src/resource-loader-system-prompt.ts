import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalSystemPromptResource } from "./resource-loader-contracts.ts";

export const MAX_GLOBAL_SYSTEM_PROMPT_BYTES = 16_384;

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

export function loadGlobalSystemPrompt(userRoot: string): GlobalSystemPromptResource | undefined {
	const sourcePath = join(userRoot, "system-prompt.md");

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
		return { instructions, sourcePath, sha256: sha256(bytes) };
	} catch (error) {
		if (error instanceof GlobalSystemPromptError) throw error;
		throw new GlobalSystemPromptError(sourcePath, "could not be read", { cause: error });
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
