import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mutationPreview } from "./agent-approved-file-preview.ts";
import {
	assertPathIdentity,
	beginApprovedFileTransaction,
	discardStaged,
	finishApprovedFileTransaction,
	restoreMovedTarget,
	stageContent,
} from "./agent-approved-file-transaction.ts";
import type { AgentToolApprovalCallback } from "./agent-approved-tools.ts";

const MAX_PREVIEW_CHARACTERS = 32_768;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
function containedRelative(root: string, target: string): string | undefined {
	const candidate = relative(root, target);
	if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
		return undefined;
	}
	return candidate;
}
async function resolveTarget(projectRoot: string, absolutePath: string) {
	const configuredRoot = resolve(projectRoot);
	const canonicalRoot = await realpath(configuredRoot);
	const requestedTarget = resolve(absolutePath);
	const targetPath =
		containedRelative(configuredRoot, requestedTarget) ?? containedRelative(canonicalRoot, requestedTarget);
	if (!targetPath) throw new Error(`Mutation target is outside the project: ${absolutePath}`);
	return { canonicalRoot, targetPath, absolutePath: resolve(canonicalRoot, targetPath) };
}
async function rejectSymlinkComponents(root: string, targetPath: string): Promise<void> {
	const components = targetPath.split(sep);
	for (let index = -1; index < components.length; index += 1) {
		const candidate = index < 0 ? root : join(root, ...components.slice(0, index + 1));
		try {
			const status = await lstat(candidate);
			if (status.isSymbolicLink()) throw new Error(`Mutation target contains a symbolic link: ${candidate}`);
			if (index < components.length - 1 && !status.isDirectory()) {
				throw new Error(`Mutation target parent is not a directory: ${candidate}`);
			}
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
	}
}
async function createParentDirectories(root: string, targetPath: string): Promise<void> {
	const parents = dirname(targetPath) === "." ? [] : dirname(targetPath).split(sep);
	for (let index = 0; index < parents.length; index += 1) {
		const candidate = join(root, ...parents.slice(0, index + 1));
		try {
			await mkdir(candidate);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const status = await lstat(candidate);
		if (status.isSymbolicLink()) throw new Error(`Mutation target contains a symbolic link: ${candidate}`);
		if (!status.isDirectory()) throw new Error(`Mutation target parent is not a directory: ${candidate}`);
	}
}
async function readHandle(handle: FileHandle): Promise<string> {
	const size = (await handle.stat()).size;
	const data = Buffer.alloc(size);
	let offset = 0;
	while (offset < data.length) {
		const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return data.subarray(0, offset).toString("utf8");
}
export async function approvedFileWrite(input: {
	readonly approvalId: string;
	readonly toolName: "edit" | "write";
	readonly projectRoot: string;
	readonly absolutePath: string;
	readonly content: string;
	readonly signal?: AbortSignal;
	readonly requestApproval: AgentToolApprovalCallback;
}): Promise<void> {
	const target = await resolveTarget(input.projectRoot, input.absolutePath);
	await rejectSymlinkComponents(target.canonicalRoot, target.targetPath);
	let handle: FileHandle | undefined;
	try {
		handle = await open(target.absolutePath, constants.O_RDWR | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ELOOP")
			throw new Error(`Mutation target contains a symbolic link: ${target.absolutePath}`);
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const existing = handle !== undefined;
	try {
		const before = handle ? await readHandle(handle) : "";
		const identity = handle ? await handle.stat() : undefined;
		if (identity && identity.nlink !== 1) throw new Error(`${target.targetPath} has multiple links`);
		const preview = handle ? mutationPreview(before, input.content, MAX_PREVIEW_CHARACTERS) : input.content;
		if (preview.length > MAX_PREVIEW_CHARACTERS)
			throw new Error(`Mutation preview exceeds ${MAX_PREVIEW_CHARACTERS} characters`);
		const beforeSha256 = sha256(before);
		const approved = await input.requestApproval({
			approvalId: input.approvalId,
			toolName: input.toolName,
			summary: `${input.toolName} ${target.targetPath}`,
			targetPath: target.targetPath,
			beforeSha256,
			afterSha256: sha256(input.content),
			preview,
		});
		if (!approved) throw new Error(`${input.toolName} was rejected`);
		input.signal?.throwIfAborted();
		await rejectSymlinkComponents(target.canonicalRoot, target.targetPath);
		if (handle && identity) {
			const staged = await stageContent(target.absolutePath, input.content, identity.mode & 0o777);
			const backupPath = `${target.absolutePath}.${process.pid}.${randomUUID()}.bak`;
			const journalPath = await beginApprovedFileTransaction(
				target.canonicalRoot,
				target.absolutePath,
				backupPath,
				staged.path,
				sha256(input.content),
			);
			let committed = false;
			let moved = false;
			let operationError: unknown;
			try {
				await assertPathIdentity(target.absolutePath, identity, target.targetPath);
				if (sha256(await readHandle(handle)) !== beforeSha256)
					throw new Error(`${target.targetPath} changed after approval`);
				await assertPathIdentity(target.absolutePath, identity, target.targetPath);
				input.signal?.throwIfAborted();
				await rename(target.absolutePath, backupPath);
				moved = true;
				await assertPathIdentity(backupPath, identity, target.targetPath);
				if (sha256(await readHandle(handle)) !== beforeSha256)
					throw new Error(`${target.targetPath} changed after approval`);
				input.signal?.throwIfAborted();
				try {
					await link(staged.path, target.absolutePath);
				} catch (error) {
					if (["EEXIST", "ELOOP"].includes(errorCode(error) ?? ""))
						throw new Error(`${target.targetPath} changed after approval`);
					throw error;
				}
				await unlink(staged.path);
				await assertPathIdentity(target.absolutePath, staged.stats, target.targetPath);
				await unlink(backupPath);
				moved = false;
				committed = true;
			} catch (error) {
				operationError = error;
			}
			let restorationError: unknown;
			if (!committed && moved) {
				try {
					await restoreMovedTarget(backupPath, target.absolutePath, target.targetPath);
				} catch (error) {
					restorationError = error;
				}
			}
			if (committed) await staged.handle.close();
			else await discardStaged(staged.handle, staged.path);
			if (!restorationError) await finishApprovedFileTransaction(journalPath);
			if (restorationError) throw restorationError;
			if (operationError) throw operationError;
			return;
		}
		await createParentDirectories(target.canonicalRoot, target.targetPath);
		const staged = await stageContent(target.absolutePath, input.content);
		const journalPath = await beginApprovedFileTransaction(
			target.canonicalRoot,
			target.absolutePath,
			undefined,
			staged.path,
			sha256(input.content),
		);
		let committed = false;
		let installed = false;
		try {
			await rejectSymlinkComponents(target.canonicalRoot, target.targetPath);
			input.signal?.throwIfAborted();
			await link(staged.path, target.absolutePath);
			installed = true;
			await unlink(staged.path);
			committed = true;
			const createdIdentity = await staged.handle.stat();
			await assertPathIdentity(target.absolutePath, createdIdentity, target.targetPath);
		} finally {
			if (committed) {
				await staged.handle.close();
				await finishApprovedFileTransaction(journalPath);
			} else if (installed) {
				await staged.handle.close();
			} else {
				await finishApprovedFileTransaction(journalPath);
				await discardStaged(staged.handle, staged.path);
			}
		}
	} catch (error) {
		if (!existing && ["EEXIST", "ELOOP"].includes(errorCode(error) ?? ""))
			throw new Error(`${target.targetPath} changed after approval`);
		throw error;
	} finally {
		await handle?.close();
	}
}
