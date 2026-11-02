import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";

class ScopedReadDeniedError extends Error {
	constructor() {
		super("read is limited to the task's workspace");
		this.name = "ScopedReadDeniedError";
	}
}

function beneath(root: string, path: string): boolean {
	const offset = relative(root, path);
	return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

/** Resolves links first, so a symlink inside a root cannot read a file outside every root. */
async function assertReadable(roots: readonly string[], absolutePath: string): Promise<string> {
	const target = await realpath(absolutePath);
	const canonicalRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
	if (!canonicalRoots.some((root) => root !== undefined && beneath(root, target))) throw new ScopedReadDeniedError();
	return target;
}

/** The read tool, refusing any file whose real path is outside the readable roots. */
export function createScopedReadTool(projectRoot: string, readableRoots: readonly string[]): ToolDefinition {
	return createReadToolDefinition(projectRoot, {
		operations: {
			readFile: async (absolutePath) => readFile(await assertReadable(readableRoots, absolutePath)),
			access: async (absolutePath) => access(await assertReadable(readableRoots, absolutePath), constants.R_OK),
		},
	}) as unknown as ToolDefinition;
}
