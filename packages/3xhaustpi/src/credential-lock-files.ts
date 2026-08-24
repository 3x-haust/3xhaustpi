import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	closeSync,
	fstatSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MILLISECONDS = 30_000;
const LOCK_TIMEOUT_MILLISECONDS = 10_000;
const lockEvents = new EventEmitter();

interface LockSnapshot {
	readonly device: number;
	readonly inode: number;
	readonly modifiedAt: number;
	readonly pid?: number;
	readonly token?: string;
}

export interface LockOwner {
	readonly descriptor: number;
	readonly device: number;
	readonly inode: number;
	readonly token: string;
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { readonly code?: unknown }).code)
		: "";
}

function readLock(path: string): LockSnapshot | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const stats = fstatSync(descriptor);
		let pid: number | undefined;
		let token: string | undefined;
		try {
			const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>;
			if (Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) pid = Number(parsed.pid);
			if (typeof parsed.token === "string") token = parsed.token;
		} catch {
			// A malformed lock is still identified by its device and inode for stale reclamation.
		}
		return { device: stats.dev, inode: stats.ino, modifiedAt: stats.mtimeMs, pid, token };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function sameLock(left: LockSnapshot | undefined, right: LockSnapshot | undefined): boolean {
	return left !== undefined && right !== undefined && left.device === right.device && left.inode === right.inode;
}

function ownerIsAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function removeIfOwned(path: string, owner: LockOwner): void {
	const current = readLock(path);
	if (current?.device !== owner.device || current.inode !== owner.inode || current.token !== owner.token) {
		return;
	}
	try {
		unlinkSync(path);
		lockEvents.emit(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

export function recoverAbandonedCredentialReclamation(path: string): boolean {
	const observed = readLock(path);
	if (!observed || Date.now() - observed.modifiedAt <= LOCK_STALE_MILLISECONDS || ownerIsAlive(observed.pid)) {
		return false;
	}
	const quarantine = `${path}.${randomUUID()}.stale`;
	try {
		renameSync(path, quarantine);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return true;
		throw error;
	}
	lockEvents.emit(path);
	const moved = readLock(quarantine);
	if (sameLock(observed, moved) && moved && !ownerIsAlive(moved.pid)) {
		unlinkSync(quarantine);
		return true;
	}
	try {
		linkSync(quarantine, path);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	try {
		unlinkSync(quarantine);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	lockEvents.emit(path);
	return true;
}

function createLock(path: string): LockOwner | undefined {
	let descriptor: number | undefined;
	let device: number | undefined;
	let inode: number | undefined;
	try {
		descriptor = openSync(path, "wx", 0o600);
		const token = randomUUID();
		const stats = fstatSync(descriptor);
		device = stats.dev;
		inode = stats.ino;
		writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }), "utf8");
		return { descriptor, device, inode, token };
	} catch (error) {
		if (descriptor !== undefined) {
			closeSync(descriptor);
			const current = readLock(path);
			if (current?.device === device && current?.inode === inode) {
				try {
					unlinkSync(path);
				} catch (unlinkError) {
					if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
				}
			}
		}
		if (errorCode(error) === "EEXIST") return undefined;
		throw error;
	}
}

function waitForLockChange(path: string, observed: LockSnapshot, milliseconds: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let watcher: ReturnType<typeof watch> | undefined;
		let timeout: NodeJS.Timeout | undefined;
		const changed = () => finish();
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			watcher?.close();
			lockEvents.removeListener(path, changed);
			if (error) reject(error);
			else resolve();
		};
		try {
			watcher = watch(path, () => finish());
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				finish();
				return;
			}
			throw error;
		}
		lockEvents.once(path, changed);
		watcher.on("error", (error) => finish(error));
		timeout = setTimeout(() => finish(new Error("Credential store lock timed out")), milliseconds);
		if (!sameLock(observed, readLock(path))) finish();
	});
}

export async function acquireCredentialLock(path: string): Promise<LockOwner> {
	const lockPath = `${path}.lock`;
	const reclaimPath = `${lockPath}.reclaim`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
	let owner: LockOwner | undefined;
	while (owner === undefined) {
		const reclamation = readLock(reclaimPath);
		if (reclamation) {
			if (recoverAbandonedCredentialReclamation(reclaimPath)) continue;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Credential store lock timed out");
			await waitForLockChange(reclaimPath, reclamation, remaining);
			continue;
		}
		owner = createLock(lockPath);
		if (owner) break;
		const observed = readLock(lockPath);
		if (observed === undefined) continue;
		if (Date.now() - observed.modifiedAt > LOCK_STALE_MILLISECONDS && !ownerIsAlive(observed.pid)) {
			const reclaimer = createLock(reclaimPath);
			if (!reclaimer) continue;
			try {
				const current = readLock(lockPath);
				const guard = readLock(reclaimPath);
				if (
					sameLock(observed, current) &&
					current !== undefined &&
					guard?.device === reclaimer.device &&
					guard.inode === reclaimer.inode &&
					guard.token === reclaimer.token &&
					Date.now() - current.modifiedAt > LOCK_STALE_MILLISECONDS &&
					!ownerIsAlive(current.pid)
				) {
					try {
						unlinkSync(lockPath);
						lockEvents.emit(lockPath);
					} catch (unlinkError) {
						if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
					}
				}
			} finally {
				try {
					removeIfOwned(reclaimPath, reclaimer);
				} finally {
					closeSync(reclaimer.descriptor);
				}
			}
			continue;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Credential store lock timed out");
		await waitForLockChange(lockPath, observed, remaining);
	}
	return owner;
}

export function releaseCredentialLock(path: string, owner: LockOwner): void {
	try {
		removeIfOwned(`${path}.lock`, owner);
	} finally {
		closeSync(owner.descriptor);
	}
}
