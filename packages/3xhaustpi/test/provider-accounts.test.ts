import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	addCodexAccount,
	codexCredentialStorageId,
	deleteCodexAccount,
	listCodexAccounts,
	selectCodexAccount,
} from "../src/provider-accounts.ts";

class MemoryCredentialStore implements CredentialStore {
	readonly credentials = new Map<string, Credential>();

	constructor(entries: readonly (readonly [string, Credential])[]) {
		for (const [providerId, credential] of entries) this.credentials.set(providerId, credential);
	}

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
		const current = this.credentials.get(providerId);
		const next = await fn(current);
		if (next !== undefined) this.credentials.set(providerId, next);
		return next ?? current;
	}

	delete(providerId: string): Promise<void> {
		this.credentials.delete(providerId);
		return Promise.resolve();
	}
}

function codexCredential(accountId: string, email: string): Extract<Credential, { readonly type: "oauth" }> {
	return {
		type: "oauth",
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 60_000,
		accountId,
		email,
	};
}

describe("Codex OAuth account management", () => {
	it("imports the active singleton and lists every saved account with a readable label", async () => {
		const store = new MemoryCredentialStore([["openai-codex", codexCredential("acct-a", "alpha@example.com")]]);

		const accounts = await listCodexAccounts(store);

		expect(accounts).toEqual([{ accountId: "acct-a", label: "alpha@example.com", active: true }]);
		expect(
			(await store.list()).filter(({ providerId }) => providerId.startsWith("openai-codex.account.")),
		).toHaveLength(1);
	});

	it("keeps multiple OAuth logins and switches the active Codex account", async () => {
		const store = new MemoryCredentialStore([["openai-codex", codexCredential("acct-a", "alpha@example.com")]]);
		const added = await addCodexAccount(store, async () => {
			await store.modify("openai-codex", async () => codexCredential("acct-b", "beta@example.com"));
		});

		expect(added).toEqual({ accountId: "acct-b", label: "beta@example.com", active: true });
		expect(await listCodexAccounts(store)).toEqual([
			{ accountId: "acct-b", label: "beta@example.com", active: true },
			{ accountId: "acct-a", label: "alpha@example.com", active: false },
		]);

		expect(await selectCodexAccount(store, "acct-a")).toEqual({
			accountId: "acct-a",
			label: "alpha@example.com",
			active: true,
		});
		expect(await store.read("openai-codex")).toMatchObject({ accountId: "acct-a" });
	});

	it("deletes one account and selects a remaining account when the active one is removed", async () => {
		const store = new MemoryCredentialStore([["openai-codex", codexCredential("acct-a", "alpha@example.com")]]);
		await listCodexAccounts(store);
		await store.modify("openai-codex", async () => codexCredential("acct-b", "beta@example.com"));
		await listCodexAccounts(store);

		const result = await deleteCodexAccount(store, "acct-b");

		expect(result).toEqual({
			deleted: { accountId: "acct-b", label: "beta@example.com", active: true },
			active: { accountId: "acct-a", label: "alpha@example.com", active: true },
		});
		expect(await listCodexAccounts(store)).toEqual([
			{ accountId: "acct-a", label: "alpha@example.com", active: true },
		]);
	});

	it("does not overwrite a fresher saved credential with a stale global copy during listing", async () => {
		const global = codexCredential("acct-a", "alpha@example.com");
		const store = new MemoryCredentialStore([["openai-codex", global]]);
		await listCodexAccounts(store);
		const storageId = codexCredentialStorageId("acct-a");
		await store.modify(storageId, async () => ({
			...global,
			access: "fresh-saved-access",
			refresh: "fresh-saved-refresh",
			expires: global.expires + 120_000,
		}));
		await store.modify("openai-codex", async () => ({
			...global,
			access: "stale-global-access",
			expires: global.expires,
		}));

		await listCodexAccounts(store);

		expect(await store.read(storageId)).toMatchObject({
			access: "fresh-saved-access",
			refresh: "fresh-saved-refresh",
		});
		expect(await store.read("openai-codex")).toMatchObject({
			access: "fresh-saved-access",
			refresh: "fresh-saved-refresh",
			expires: global.expires + 120_000,
		});
	});

	it("sanitizes credential-derived labels before returning account inventory", async () => {
		const store = new MemoryCredentialStore([
			[
				"openai-codex",
				codexCredential("acct-a", "\u001b]8;;https://evil.invalid\u0007owner@example.com\nFORGED ROW"),
			],
		]);

		const [account] = await listCodexAccounts(store);

		expect(account?.label).not.toMatch(/[\u001b\u0007\n\r]/u);
		expect(account?.label).toContain("owner@example.com");
		expect(account?.label).toContain("FORGED ROW");
	});
});
