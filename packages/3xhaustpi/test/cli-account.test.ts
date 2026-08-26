import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { deleteConfirmedCodexAccount } from "../src/cli-account.ts";
import { addCodexAccount, listCodexAccounts, selectCodexAccount } from "../src/provider-accounts.ts";

class MemoryCredentialStore implements CredentialStore {
	readonly credentials = new Map<string, Credential>();

	read(providerId: string): Promise<Credential | undefined> {
		return Promise.resolve(this.credentials.get(providerId));
	}

	list(): Promise<readonly CredentialInfo[]> {
		return Promise.resolve(
			[...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type })),
		);
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const next = await fn(this.credentials.get(providerId));
		if (next) this.credentials.set(providerId, next);
		return next;
	}

	delete(providerId: string): Promise<void> {
		this.credentials.delete(providerId);
		return Promise.resolve();
	}
}

function credential(accountId: string): Credential {
	return {
		type: "oauth",
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 60_000,
		accountId,
		email: `${accountId}@example.com`,
	};
}

describe("CLI account deletion", () => {
	it("deletes the already-confirmed full account ID even if numeric ordering changes", async () => {
		const store = new MemoryCredentialStore();
		await store.modify("openai-codex", async () => credential("acct-a"));
		await listCodexAccounts(store);
		await addCodexAccount(store, async () => {
			await store.modify("openai-codex", async () => credential("acct-b"));
		});

		const result = await deleteConfirmedCodexAccount(store, "1", async () => {
			await selectCodexAccount(store, "acct-a");
			return true;
		});

		expect(result?.deleted.accountId).toBe("acct-b");
		expect(await listCodexAccounts(store)).toEqual([
			{ accountId: "acct-a", label: "acct-a@example.com", active: true },
		]);
	});
});
