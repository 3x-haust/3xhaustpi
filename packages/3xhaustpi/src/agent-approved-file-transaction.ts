import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

export async function assertPathIdentity(path: string, expected: Stats, targetPath: string): Promise<void> {
	let current: Stats;
	try {
		current = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") throw new Error(`${targetPath} changed after approval`);
		throw error;
	}
	if (
		current.isSymbolicLink() ||
		!current.isFile() ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino ||
		current.nlink !== 1
	)
		throw new Error(`${targetPath} changed after approval`);
}

export async function replaceHandleContent(handle: FileHandle, content: string): Promise<void> {
	await handle.truncate(0);
	await handle.writeFile(content, "utf8");
	await handle.sync();
}

export async function stageContent(absolutePath: string, content: string, mode?: number) {
	const path = join(dirname(absolutePath), `.${process.pid}.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			path,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			mode ?? 0o666,
		);
		if (mode !== undefined) await handle.chmod(mode);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		const stats = await handle.stat();
		if (!stats.isFile() || stats.nlink !== 1) throw new Error("staged write target is unsafe");
		return { path, handle, stats };
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(path).catch(() => {});
		throw error;
	}
}

export async function discardStaged(handle: FileHandle, path: string): Promise<void> {
	try {
		await handle.close();
	} finally {
		await unlink(path).catch((error: unknown) => {
			if (errorCode(error) !== "ENOENT") throw error;
		});
	}
}

export async function restoreMovedTarget(backupPath: string, targetPath: string, displayPath: string): Promise<void> {
	try {
		await link(backupPath, targetPath);
	} catch (error) {
		if (["EEXIST", "ELOOP"].includes(errorCode(error) ?? "")) {
			throw new Error(`${displayPath} changed during commit; prior content is preserved at ${backupPath}`);
		}
		throw error;
	}
	await unlink(backupPath);
}

interface ApprovedWriteTransaction {
	readonly version: 1;
	readonly targetPath: string;
	readonly backupPath?: string;
	readonly stagePath: string;
	readonly afterSha256: string;
}

function transactionDirectory(projectRoot: string): string {
	const projectHash = createHash("sha256").update(resolve(projectRoot)).digest("hex");
	return join(getAgentDir(), "3xhaustpi-approved-write-transactions", projectHash);
}

async function installNoReplace(sourcePath: string, targetPath: string): Promise<void> {
	await link(sourcePath, targetPath);
	await unlink(sourcePath);
}

async function containedPath(projectRoot: string, value: string): Promise<string> {
	const canonicalRoot = await realpath(projectRoot);
	const canonicalParent = await realpath(dirname(resolve(value)));
	const absolute = join(canonicalParent, basename(value));
	const candidate = relative(canonicalRoot, absolute);
	if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate))
		throw new Error("Approved write transaction escaped the project");
	return absolute;
}

export async function beginApprovedFileTransaction(
	projectRoot: string,
	targetPath: string,
	backupPath: string | undefined,
	stagePath: string,
	afterSha256: string,
): Promise<string> {
	const directory = transactionDirectory(projectRoot);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const journalPath = join(directory, `${randomUUID()}.json`);
	const temporaryPath = `${journalPath}.tmp`;
	const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await handle.writeFile(JSON.stringify({ version: 1, targetPath, backupPath, stagePath, afterSha256 }), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporaryPath, journalPath);
	const directoryHandle = await open(directory, constants.O_RDONLY);
	try {
		await directoryHandle.sync().catch((error: unknown) => {
			if (!["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(errorCode(error) ?? "")) throw error;
		});
	} finally {
		await directoryHandle.close();
	}
	return journalPath;
}

export async function finishApprovedFileTransaction(journalPath: string): Promise<void> {
	await unlink(journalPath);
}

export async function recoverApprovedFileTransactions(projectRoot: string): Promise<void> {
	const directory = transactionDirectory(projectRoot);
	let journalNames: string[];
	try {
		journalNames = await readdir(directory);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	for (const journalName of journalNames.filter((name) => name.endsWith(".json"))) {
		const journalPath = join(directory, journalName);
		const transaction = JSON.parse(await readFile(journalPath, "utf8")) as ApprovedWriteTransaction;
		if (transaction.version !== 1 || !/^[a-f0-9]{64}$/u.test(transaction.afterSha256))
			throw new Error(`Invalid approved write transaction: ${journalPath}`);
		if (typeof transaction.stagePath !== "string")
			throw new Error(`Invalid approved write transaction: ${journalPath}`);
		const targetPath = await containedPath(projectRoot, transaction.targetPath);
		const backupPath = transaction.backupPath ? await containedPath(projectRoot, transaction.backupPath) : undefined;
		const stagePath = await containedPath(projectRoot, transaction.stagePath);
		const exists = async (path: string) => {
			try {
				await lstat(path);
				return true;
			} catch (error) {
				if (errorCode(error) === "ENOENT") return false;
				throw error;
			}
		};
		const targetExists = await exists(targetPath);
		const backupExists = backupPath ? await exists(backupPath) : false;
		const stageExists = await exists(stagePath);
		const removeStage = async () => {
			if (stageExists) await unlink(stagePath);
		};
		if (!backupPath) {
			if (!targetExists && stageExists) await installNoReplace(stagePath, targetPath);
			else if (targetExists) {
				const actualHash = createHash("sha256")
					.update(await readFile(targetPath))
					.digest("hex");
				if (actualHash !== transaction.afterSha256)
					throw new Error(
						`Interrupted approved write requires review; staged content is preserved at ${stagePath}`,
					);
				await removeStage();
			} else throw new Error(`Interrupted approved write lost both paths: ${targetPath}`);
			await unlink(journalPath);
			continue;
		}
		if (!backupExists) {
			if (!targetExists) throw new Error(`Interrupted approved write lost both paths: ${targetPath}`);
			await removeStage();
			await unlink(journalPath);
			continue;
		}
		if (!targetExists) {
			await installNoReplace(backupPath, targetPath);
			await removeStage();
			await unlink(journalPath);
			continue;
		}
		const actualHash = createHash("sha256")
			.update(await readFile(targetPath))
			.digest("hex");
		if (actualHash !== transaction.afterSha256) {
			throw new Error(`Interrupted approved write requires review; prior content is preserved at ${backupPath}`);
		}
		await removeStage();
		await unlink(backupPath);
		await unlink(journalPath);
	}
}
