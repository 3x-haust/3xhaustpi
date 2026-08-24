import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { parseCredentials, type StoredCredentials } from "./credential-store-contracts.ts";
import { withCredentialLock, writePrivateJson } from "./credential-store-files.ts";

export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(path: string) {
		this.#path = path;
	}

	async #withLock<T>(operation: () => Promise<T>): Promise<T> {
		return withCredentialLock(this.#path, operation);
	}

	#write(credentials: StoredCredentials): void {
		writePrivateJson(this.#path, credentials);
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

	async read(providerId: string): Promise<Credential | undefined> {
		return parseCredentials(this.#path)[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(parseCredentials(this.#path)).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, () =>
			this.#withLock(async () => {
				const credentials = parseCredentials(this.#path);
				const current = credentials[providerId];
				const next = await fn(current);
				if (next === undefined) return current;
				this.#write({ ...credentials, [providerId]: next });
				return next;
			}),
		);
	}

	delete(providerId: string): Promise<void> {
		return this.#enqueue(providerId, () =>
			this.#withLock(async () => {
				const credentials = parseCredentials(this.#path);
				if (!(providerId in credentials)) return;
				const { [providerId]: _removed, ...remaining } = credentials;
				this.#write(remaining);
			}),
		);
	}
}
