import { randomUUID } from "node:crypto";
import { fstatSync, linkSync, readFileSync, renameSync, rmSync, type Stats, unlinkSync } from "node:fs";
import { readPatchDescriptor } from "./coding-runtime-patch-descriptor.ts";

type VerifyPath = (path: string) => Stats | undefined;

interface WindowsReplacement {
	readonly path: string;
	readonly backupPath: string;
	readonly stagedPath: string;
	readonly sourceDescriptor: number;
	readonly sourceStats: Stats;
	readonly before: Buffer;
	readonly verify: VerifyPath;
}

interface WindowsRollback {
	readonly path: string;
	readonly displacedPath: string;
	readonly backupPath: string;
	readonly appliedStats: Stats;
	readonly originalDescriptor: number;
	readonly before: Buffer;
	readonly after: Buffer;
	readonly verify: VerifyPath;
}

const isSameFile = (left: Stats, right: Stats | undefined): boolean =>
	right !== undefined && left.dev === right.dev && left.ino === right.ino;

export function patchTemporaryPath(path: string): string {
	return `${path}.${process.pid}.${randomUUID()}.patch`;
}

export function linkNoReplace(sourcePath: string, targetPath: string): void {
	linkSync(sourcePath, targetPath);
	unlinkSync(sourcePath);
}

export function replaceExistingWindows(replacement: WindowsReplacement): void {
	const { path, backupPath, stagedPath, sourceDescriptor, sourceStats, before, verify } = replacement;
	renameSync(path, backupPath);
	if (!isSameFile(sourceStats, verify(backupPath)) || !readPatchDescriptor(sourceDescriptor).equals(before)) {
		if (!verify(path)) linkNoReplace(backupPath, path);
		throw new Error(`Patch target changed before apply: ${path}`);
	}
	try {
		linkNoReplace(stagedPath, path);
	} catch (error) {
		if (!verify(path)) linkNoReplace(backupPath, path);
		if (verify(backupPath)) {
			throw new AggregateError([error], `Patch target changed during apply; original preserved at ${backupPath}`);
		}
		throw error;
	}
}

export function rollbackExistingWindows(rollback: WindowsRollback): void {
	const { path, displacedPath, backupPath, appliedStats, originalDescriptor, before, after, verify } = rollback;
	renameSync(path, displacedPath);
	if (!isSameFile(appliedStats, verify(displacedPath)) || !readFileSync(displacedPath).equals(after)) {
		if (!verify(path)) linkNoReplace(displacedPath, path);
		throw new Error(`Patch target changed during rollback: ${path}`);
	}
	linkNoReplace(backupPath, path);
	rmSync(displacedPath);
	if (
		!isSameFile(fstatSync(originalDescriptor), verify(path)) ||
		!readPatchDescriptor(originalDescriptor).equals(before)
	) {
		throw new Error(`Patch target changed during rollback: ${path}`);
	}
}
