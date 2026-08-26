import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverAbandonedCredentialReclamation, withCredentialLock } from "../src/credential-store-files.ts";

const temporaryDirectories: string[] = [];

function temporaryCredentialPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-credential-lock-"));
	temporaryDirectories.push(directory);
	return join(directory, "auth.json");
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function lockOwner(path: string): { readonly pid: number; readonly token: string } {
	return JSON.parse(readFileSync(`${path}.lock`, "utf8")) as { readonly pid: number; readonly token: string };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("credential file locking", () => {
	it("writes a private unpredictable owner token and reclaims an abandoned stale lock", async () => {
		const path = temporaryCredentialPath();
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, JSON.stringify({ token: "abandoned" }), { mode: 0o600 });
		const stale = new Date(Date.now() - 31_000);
		utimesSync(lockPath, stale, stale);

		let owner: ReturnType<typeof lockOwner> | undefined;
		await withCredentialLock(path, async () => {
			owner = lockOwner(path);
			expect(owner.pid).toBe(process.pid);
			expect(owner.token).toMatch(/^[0-9a-f-]{36}$/u);
			expect(owner.token).not.toBe("abandoned");
			if (process.platform !== "win32") expect(statSync(lockPath).mode & 0o777).toBe(0o600);
		});

		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not reclaim a fresh guard before it becomes abandoned and stale", async () => {
		const path = temporaryCredentialPath();
		const lockPath = `${path}.lock`;
		const reclaimPath = `${lockPath}.reclaim`;
		writeFileSync(lockPath, JSON.stringify({ token: "abandoned" }), { mode: 0o600 });
		writeFileSync(reclaimPath, JSON.stringify({ pid: 2_147_483_647, token: "reclaimer" }), { mode: 0o600 });
		const stale = new Date(Date.now() - 31_000);
		utimesSync(lockPath, stale, stale);
		let entered = false;

		const operation = withCredentialLock(path, async () => {
			entered = true;
		});
		expect(entered).toBe(false);
		expect(lockOwner(path).token).toBe("abandoned");

		utimesSync(reclaimPath, stale, stale);
		expect(recoverAbandonedCredentialReclamation(reclaimPath)).toBe(true);
		await operation;
		expect(entered).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers an abandoned stale reclamation guard", async () => {
		const path = temporaryCredentialPath();
		const lockPath = `${path}.lock`;
		const reclaimPath = `${lockPath}.reclaim`;
		writeFileSync(lockPath, JSON.stringify({ token: "abandoned-lock" }), { mode: 0o600 });
		writeFileSync(reclaimPath, JSON.stringify({ token: "abandoned-reclaimer" }), { mode: 0o600 });
		const stale = new Date(Date.now() - 31_000);
		utimesSync(lockPath, stale, stale);
		utimesSync(reclaimPath, stale, stale);

		await withCredentialLock(path, async () => {
			expect(lockOwner(path).token).not.toBe("abandoned-lock");
		});

		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(reclaimPath)).toBe(false);
	}, 15_000);

	it("does not unlink a replacement lock when a stale holder releases", async () => {
		const path = temporaryCredentialPath();
		const lockPath = `${path}.lock`;
		const releaseA = deferred();
		const enteredA = deferred();
		const operationA = withCredentialLock(path, async () => {
			enteredA.resolve();
			await releaseA.promise;
		});
		await enteredA.promise;
		const ownerA = lockOwner(path);
		const stale = new Date(Date.now() - 31_000);
		utimesSync(lockPath, stale, stale);
		unlinkSync(lockPath);

		const releaseB = deferred();
		const enteredB = deferred();
		const operationB = withCredentialLock(path, async () => {
			enteredB.resolve();
			await releaseB.promise;
		});
		await enteredB.promise;
		const ownerB = lockOwner(path);
		expect(ownerB.token).not.toBe(ownerA.token);

		releaseA.resolve();
		await operationA;
		expect(lockOwner(path)).toEqual(ownerB);

		releaseB.resolve();
		await operationB;
		expect(existsSync(lockPath)).toBe(false);
	});

	it("never runs two critical sections for a live stale owner", async () => {
		const path = temporaryCredentialPath();
		const releaseA = deferred();
		const enteredA = deferred();
		const entries: string[] = [];
		const operationA = withCredentialLock(path, async () => {
			entries.push("A");
			enteredA.resolve();
			await releaseA.promise;
		});
		await enteredA.promise;
		const stale = new Date(Date.now() - 31_000);
		utimesSync(`${path}.lock`, stale, stale);

		const enteredB = deferred();
		const operationB = withCredentialLock(path, async () => {
			entries.push("B");
			enteredB.resolve();
		});
		expect(entries).toEqual(["A"]);

		releaseA.resolve();
		await operationA;
		await enteredB.promise;
		await operationB;
		expect(entries).toEqual(["A", "B"]);
	});
});
