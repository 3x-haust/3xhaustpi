import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function canonicalProject(input: string | undefined): string {
	const target = resolve(input ?? process.cwd());
	if (!existsSync(target)) throw new Error(`Project directory does not exist: ${target}`);
	if (!statSync(target).isDirectory()) throw new Error(`Project path is not a directory: ${target}`);
	return realpathSync(target);
}
