import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { AsyncEntry } from "@napi-rs/keyring";
import {
	isCredential,
	readCredentialMetadata,
	type SecureCredentialEntryFactory,
} from "./credential-store-contracts.ts";
import { withCredentialLock, writePrivateJson } from "./credential-store-files.ts";
import { migrateCredentials } from "./credential-store-migration.ts";

export interface SystemCredentialStoreOptions {
	readonly service?: string;
	readonly legacyService?: string;
	readonly entryFactory?: SecureCredentialEntryFactory;
	readonly legacyEntryFactory?: SecureCredentialEntryFactory;
}

export class SystemCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #entryFactory: SecureCredentialEntryFactory;
	readonly #legacyEntryFactory: SecureCredentialEntryFactory | undefined;
	readonly #chains = new Map<string, Promise<unknown>>();
	#migration: Promise<void> | undefined;

	constructor(path: string, options: SystemCredentialStoreOptions = {}) {
		this.#path = path;
		const service = options.service ?? "io.3xhaustpi.cli.credentials.v1";
		this.#entryFactory =
			options.entryFactory ??
			((providerId) => {
				return new AsyncEntry(service, providerId);
			});
		this.#legacyEntryFactory =
			options.legacyEntryFactory ??
			(options.legacyService ? (providerId) => new AsyncEntry(options.legacyService!, providerId) : undefined);
	}

	#enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(operation);
		this.#chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	#metadata() {
		return readCredentialMetadata(this.#path);
	}

	async #readSecure(providerId: string): Promise<Credential | undefined> {
		const entry = this.#entryFactory(providerId);
		let serialized = await entry.getPassword();
		if (
			(serialized === undefined || serialized === null) &&
			this.#legacyEntryFactory &&
			providerId in this.#metadata()
		) {
			serialized = await this.#legacyEntryFactory(providerId).getPassword();
			if (serialized !== undefined && serialized !== null) {
				await entry.setPassword(serialized);
				if ((await entry.getPassword()) !== serialized) {
					throw new Error(`OS credential migration verification failed for provider ${providerId}`);
				}
			}
		}
		if (serialized === undefined || serialized === null) return undefined;
		const parsed = JSON.parse(serialized) as unknown;
		if (!isCredential(parsed)) throw new Error(`OS credential entry is invalid for provider ${providerId}`);
		return parsed;
	}

	async #restore(providerId: string, credential: Credential | undefined): Promise<void> {
		const entry = this.#entryFactory(providerId);
		if (credential === undefined) {
			await entry.deleteCredential();
			return;
		}
		await entry.setPassword(JSON.stringify(credential));
	}

	async #ensureMigrated(): Promise<void> {
		this.#migration ??= migrateCredentials({
			path: this.#path,
			entryFactory: this.#entryFactory,
			readSecure: (providerId) => this.#readSecure(providerId),
			restore: (providerId, credential) => this.#restore(providerId, credential),
		});
		return this.#migration;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		await this.#ensureMigrated();
		return this.#readSecure(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		await this.#ensureMigrated();
		return Object.entries(this.#metadata()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, async () => {
			await this.#ensureMigrated();
			return withCredentialLock(this.#path, async () => {
				const current = await this.#readSecure(providerId);
				const next = await fn(current);
				if (next === undefined) return current;
				const entry = this.#entryFactory(providerId);
				const serialized = JSON.stringify(next);
				try {
					await entry.setPassword(serialized);
					if ((await entry.getPassword()) !== serialized) {
						throw new Error(`OS credential verification failed for provider ${providerId}`);
					}
					writePrivateJson(this.#path, {
						...this.#metadata(),
						[providerId]: { type: next.type, storage: "os-keyring" },
					});
				} catch (cause) {
					await this.#restore(providerId, current).catch(() => {});
					throw cause;
				}
				return next;
			});
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#enqueue(providerId, async () => {
			await this.#ensureMigrated();
			await withCredentialLock(this.#path, async () => {
				const current = await this.#readSecure(providerId);
				const metadata = this.#metadata();
				if (current === undefined && !(providerId in metadata)) return;
				try {
					await this.#entryFactory(providerId).deleteCredential();
					const { [providerId]: _removed, ...remaining } = metadata;
					writePrivateJson(this.#path, remaining);
				} catch (cause) {
					await this.#restore(providerId, current).catch(() => {});
					throw cause;
				}
			});
		});
	}
}

export function systemCredentialStoreName(platform = process.platform): string {
	if (platform === "darwin") return "macOS Keychain";
	if (platform === "win32") return "Windows Credential Manager";
	if (platform === "linux") return "Linux Secret Service";
	return "OS credential store";
}
