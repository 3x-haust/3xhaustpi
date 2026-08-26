import { chmodSync, closeSync, constants, fstatSync, openSync, renameSync, rmSync, type Stats } from "node:fs";
import type { DescriptorWrite } from "./coding-runtime-patch-descriptor.ts";
import { readPatchDescriptor, writePatchDescriptor } from "./coding-runtime-patch-descriptor.ts";
import {
	linkNoReplace,
	patchTemporaryPath,
	replaceExistingWindows,
	rollbackExistingWindows,
} from "./coding-runtime-patch-windows.ts";

export interface TransactionalPatchFile {
	readonly document: { readonly relativePath: string };
	readonly before: string;
	readonly after: string;
	readonly existedBefore: boolean;
}

export interface PatchTransactionBoundary {
	readonly path: (relativePath: string) => string;
	readonly verify: (path: string) => Stats | undefined;
	readonly ensureParent: (path: string) => void;
	readonly platform: NodeJS.Platform;
}

interface AppliedPatchFile {
	readonly existedBefore: boolean;
	readonly path: string;
	descriptor: number | undefined;
	originalDescriptor: number | undefined;
	readonly stats: Stats;
	readonly before: Buffer;
	readonly after: Buffer;
	readonly mode: number;
	backupPath: string | undefined;
}

class CommittedPatchError extends Error {
	readonly applied: AppliedPatchFile;

	constructor(message: string, applied: AppliedPatchFile) {
		super(message);
		this.applied = applied;
	}
}

const isSameFile = (left: Stats, right: Stats | undefined): boolean =>
	right !== undefined && left.dev === right.dev && left.ino === right.ino;

function closeApplied(opened: AppliedPatchFile): void {
	if (opened.descriptor !== undefined) {
		closeSync(opened.descriptor);
		opened.descriptor = undefined;
	}
	if (opened.originalDescriptor !== undefined) {
		closeSync(opened.originalDescriptor);
		opened.originalDescriptor = undefined;
	}
}

function openStage(path: string, content: Buffer, mode?: number, write?: DescriptorWrite) {
	const temporaryPath = patchTemporaryPath(path);
	const descriptor = openSync(
		temporaryPath,
		constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode ?? 0o644,
	);
	try {
		if (mode !== undefined) chmodSync(temporaryPath, mode);
		writePatchDescriptor(descriptor, content, write);
		return { descriptor, path: temporaryPath, stats: fstatSync(descriptor) };
	} catch (error) {
		closeSync(descriptor);
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

function rollback(opened: AppliedPatchFile, boundary: PatchTransactionBoundary): void {
	const descriptor = opened.descriptor;
	if (descriptor === undefined) throw new Error(`Patch descriptor closed before rollback: ${opened.path}`);
	if (!isSameFile(opened.stats, boundary.verify(opened.path))) {
		throw new Error(`Patch target changed while applying; rollback blocked: ${opened.path}`);
	}
	if (!readPatchDescriptor(descriptor).equals(opened.after)) {
		throw new Error(`Patch target changed after apply; rollback blocked: ${opened.path}`);
	}
	if (!opened.existedBefore) {
		if (!isSameFile(opened.stats, boundary.verify(opened.path))) {
			throw new Error(`Patch target changed during rollback: ${opened.path}`);
		}
		rmSync(opened.path);
		return;
	}
	if (opened.backupPath) {
		const originalDescriptor = opened.originalDescriptor;
		if (originalDescriptor === undefined) {
			throw new Error(`Original patch descriptor closed before rollback: ${opened.path}`);
		}
		closeSync(descriptor);
		opened.descriptor = undefined;
		rollbackExistingWindows({
			path: opened.path,
			displacedPath: patchTemporaryPath(opened.path),
			backupPath: opened.backupPath,
			appliedStats: opened.stats,
			originalDescriptor,
			before: opened.before,
			after: opened.after,
			verify: boundary.verify,
		});
		opened.backupPath = undefined;
		return;
	}
	const staged = openStage(opened.path, opened.before, opened.mode);
	try {
		if (
			!isSameFile(opened.stats, boundary.verify(opened.path)) ||
			!readPatchDescriptor(descriptor).equals(opened.after)
		) {
			throw new Error(`Patch target changed during rollback: ${opened.path}`);
		}
		renameSync(staged.path, opened.path);
		if (!isSameFile(staged.stats, boundary.verify(opened.path))) {
			throw new Error(`Patch target changed during rollback: ${opened.path}`);
		}
	} finally {
		closeSync(staged.descriptor);
		rmSync(staged.path, { force: true });
	}
}

function applyOne(
	file: TransactionalPatchFile,
	boundary: PatchTransactionBoundary,
	write?: DescriptorWrite,
): AppliedPatchFile {
	const path = boundary.path(file.document.relativePath);
	const targetStats = boundary.verify(path);
	if (file.existedBefore !== (targetStats !== undefined)) {
		throw new Error(`Patch target changed before apply: ${path}`);
	}
	if (targetStats && (!targetStats.isFile() || targetStats.nlink !== 1)) {
		throw new Error(`Patch target changed before apply: ${path}`);
	}
	boundary.ensureParent(path);
	let sourceDescriptor = targetStats ? openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) : undefined;
	const before = Buffer.from(file.before, "utf8");
	const after = Buffer.from(file.after, "utf8");
	let sourceStats: Stats | undefined;
	try {
		if (sourceDescriptor !== undefined) {
			sourceStats = fstatSync(sourceDescriptor);
			if (
				sourceStats.nlink !== 1 ||
				!isSameFile(sourceStats, targetStats) ||
				!readPatchDescriptor(sourceDescriptor).equals(before)
			) {
				throw new Error(`Patch target changed before apply: ${path}`);
			}
		}
		const mode = sourceStats ? sourceStats.mode & 0o7777 : undefined;
		const staged = openStage(path, after, mode, write);
		let committed = false;
		let backupPath: string | undefined;
		try {
			if (sourceDescriptor !== undefined && sourceStats) {
				if (
					!isSameFile(sourceStats, boundary.verify(path)) ||
					!readPatchDescriptor(sourceDescriptor).equals(before)
				) {
					throw new Error(`Patch target changed before apply: ${path}`);
				}
				if (boundary.platform === "win32") {
					backupPath = patchTemporaryPath(path);
					replaceExistingWindows({
						path,
						backupPath,
						stagedPath: staged.path,
						sourceDescriptor,
						sourceStats,
						before,
						verify: boundary.verify,
					});
				} else {
					renameSync(staged.path, path);
				}
			} else {
				if (boundary.verify(path)) throw new Error(`Patch target changed before apply: ${path}`);
				linkNoReplace(staged.path, path);
			}
			committed = true;
			const applied = {
				existedBefore: file.existedBefore,
				path,
				descriptor: staged.descriptor,
				originalDescriptor: backupPath ? sourceDescriptor : undefined,
				stats: staged.stats,
				before,
				after,
				mode: mode ?? staged.stats.mode & 0o7777,
				backupPath,
			};
			if (backupPath) sourceDescriptor = undefined;
			if (
				!isSameFile(staged.stats, boundary.verify(path)) ||
				!readPatchDescriptor(staged.descriptor).equals(after)
			) {
				throw new CommittedPatchError(`Patch target changed while applying: ${path}`, applied);
			}
			return applied;
		} finally {
			if (!committed) {
				closeSync(staged.descriptor);
				rmSync(staged.path, { force: true });
			}
		}
	} finally {
		if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
	}
}

export function applyPatchTransaction(
	files: readonly TransactionalPatchFile[],
	boundary: PatchTransactionBoundary,
	write?: DescriptorWrite,
): void {
	const applied: AppliedPatchFile[] = [];
	try {
		for (const file of files) applied.push(applyOne(file, boundary, write));
	} catch (error) {
		if (error instanceof CommittedPatchError) applied.push(error.applied);
		const rollbackErrors: unknown[] = [];
		for (const opened of applied.reverse()) {
			try {
				rollback(opened, boundary);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		for (const opened of applied) closeApplied(opened);
		if (rollbackErrors.length > 0) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new AggregateError([error, ...rollbackErrors], `Patch apply failed: ${cause}; rollback incomplete`);
		}
		throw error;
	}
	for (const opened of applied) {
		closeApplied(opened);
		if (opened.backupPath) rmSync(opened.backupPath);
	}
}
