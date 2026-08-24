import { chmodSync, existsSync } from "node:fs";
import type { Credential } from "@earendil-works/pi-ai";
import {
	type CredentialMetadata,
	isCredential,
	isCredentialMetadata,
	parseRecord,
	type SecureCredentialEntryFactory,
} from "./credential-store-contracts.ts";
import { withCredentialLock, writePrivateJson } from "./credential-store-files.ts";

export interface CredentialMigrationOptions {
	readonly path: string;
	readonly entryFactory: SecureCredentialEntryFactory;
	readonly readSecure: (providerId: string) => Promise<Credential | undefined>;
	readonly restore: (providerId: string, credential: Credential | undefined) => Promise<void>;
}

export async function migrateCredentials({
	path,
	entryFactory,
	readSecure,
	restore,
}: CredentialMigrationOptions): Promise<void> {
	return withCredentialLock(path, async () => {
		const raw = parseRecord(path);
		const legacy = Object.entries(raw).flatMap(([providerId, value]) =>
			isCredential(value) && !isCredentialMetadata(value) ? [[providerId, value] as const] : [],
		);
		if (legacy.length === 0) {
			if (existsSync(path)) chmodSync(path, 0o600);
			return;
		}

		const metadata: CredentialMetadata = Object.fromEntries(
			Object.entries(raw).flatMap(([providerId, value]) =>
				isCredentialMetadata(value) ? [[providerId, value] as const] : [],
			),
		);
		const previous: Array<readonly [string, Credential | undefined]> = [];
		try {
			for (const [providerId, credential] of legacy) {
				previous.push([providerId, await readSecure(providerId)]);
				const entry = entryFactory(providerId);
				const serialized = JSON.stringify(credential);
				await entry.setPassword(serialized);
				if ((await entry.getPassword()) !== serialized) {
					throw new Error(`OS credential verification failed for provider ${providerId}`);
				}
				metadata[providerId] = { type: credential.type, storage: "os-keyring" };
			}
			writePrivateJson(path, metadata);
		} catch (cause) {
			for (const [providerId, credential] of previous.reverse()) {
				await restore(providerId, credential).catch(() => {});
			}
			throw cause;
		}
	});
}
