import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireCredentialLock, releaseCredentialLock } from "./credential-lock-files.ts";

export { recoverAbandonedCredentialReclamation } from "./credential-lock-files.ts";

export function writePrivateJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	chmodSync(path, 0o600);
}

export async function withCredentialLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const owner = await acquireCredentialLock(path);
	try {
		return await operation();
	} finally {
		releaseCredentialLock(path, owner);
	}
}
