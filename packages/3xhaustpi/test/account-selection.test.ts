import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { eligibleModelAccounts, type ModelAccount, resolveSessionAccount } from "../src/account-selection.ts";
import { codexCredentialStorageId } from "../src/provider-accounts.ts";
import { scopedCredentialStore } from "../src/provider-runtime.ts";
import { ThreeXhaustState } from "../src/state.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-accounts-"));
	directories.push(directory);
	return {
		projectPath: join(directory, "project"),
		statePath: join(directory, "state.sqlite"),
	};
}

const accounts: readonly ModelAccount[] = [
	{
		id: "openai-codex:acct-alpha",
		providerId: "openai-codex",
		label: "alpha@example.com",
		detail: "OAuth",
		active: true,
	},
	{
		id: "openai-codex:acct-beta",
		providerId: "openai-codex",
		label: "beta@example.com",
		detail: "OAuth",
		active: false,
	},
	{
		id: "provider:anthropic",
		providerId: "anthropic",
		label: "Anthropic API key",
		detail: "ANTHROPIC_API_KEY",
		active: true,
	},
];

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

describe("session account eligibility", () => {
	it("starts with every configured account enabled and supports explicit exclusions", () => {
		expect(eligibleModelAccounts(accounts, [])).toEqual(accounts);
		expect(eligibleModelAccounts(accounts, ["openai-codex:acct-beta"])).toEqual([accounts[0], accounts[2]]);
	});

	it("chooses one stable eligible account for the session and never falls back to an excluded provider", () => {
		const first = resolveSessionAccount(accounts, [], "openai-codex", "session-a");
		const repeated = resolveSessionAccount(accounts, [], "openai-codex", "session-a");

		expect(first).toEqual(repeated);
		expect(first?.providerId).toBe("openai-codex");
		expect(resolveSessionAccount(accounts, ["openai-codex:acct-alpha"], "openai-codex", "session-a")?.id).toBe(
			"openai-codex:acct-beta",
		);
		expect(resolveSessionAccount(accounts, ["provider:anthropic"], "anthropic", "session-a")).toBeUndefined();
	});

	it("persists exclusions for a draft and promotes them when the real session starts", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);

		expect(state.listTuiAccountExclusions(projectPath)).toEqual([]);
		state.setTuiAccountsEnabled(projectPath, ["openai-codex:acct-beta"], false);
		expect(state.listTuiAccountExclusions(projectPath)).toEqual(["openai-codex:acct-beta"]);
		expect(state.findTuiProviderAccount(projectPath, "openai-codex")).toBeUndefined();
		state.setTuiProviderAccount(projectPath, "openai-codex", "openai-codex:acct-alpha");
		expect(state.findTuiProviderAccount(projectPath, "openai-codex")).toBe("openai-codex:acct-alpha");

		state.enqueueTuiRequest({
			requestId: "request-account-selection",
			projectPath,
			fingerprint: "fingerprint-account-selection",
			objective: "inspect",
			binding: {
				version: 1,
				conversationGeneration: 0,
				sessionId: null,
				provider: "openai-codex",
				model: "gpt-5.6-terra",
				accountId: "openai-codex:acct-alpha",
			},
		});
		const claim = state.claimNextTuiRequest(projectPath, { ownerId: "host-a" });
		if (!claim) throw new Error("Expected account-bound request");
		expect(claim.binding?.accountId).toBe("openai-codex:acct-alpha");

		state.publishTuiConversationSession(claim.id, {
			ownerId: claim.ownerId,
			leaseEpoch: claim.leaseEpoch,
			projectPath,
			expectedGeneration: 0,
			sessionId: "session-account-selection",
		});
		expect(state.listTuiAccountExclusions(projectPath)).toEqual(["openai-codex:acct-beta"]);
		expect(state.findTuiProviderAccount(projectPath, "openai-codex")).toBe("openai-codex:acct-alpha");

		state.setTuiAccountsEnabled(projectPath, ["openai-codex:acct-beta"], true);
		expect(state.listTuiAccountExclusions(projectPath)).toEqual([]);
		state.close();
	});

	it("persists project cache-warm preference without a conversation session", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);

		expect(state.findTuiProjectPreference(projectPath, "cache-warm")).toBeUndefined();
		state.setTuiProjectPreference(projectPath, "cache-warm", "eligible");
		expect(state.findTuiProjectPreference(projectPath, "cache-warm")).toBe("eligible");
		state.close();

		const reopened = new ThreeXhaustState(statePath);
		expect(reopened.findTuiProjectPreference(projectPath, "cache-warm")).toBe("eligible");
		reopened.setTuiProjectPreference(projectPath, "cache-warm", undefined);
		expect(reopened.findTuiProjectPreference(projectPath, "cache-warm")).toBeUndefined();
		reopened.close();
	});

	it("routes Codex reads and refresh writes through the selected saved account without global mutation", async () => {
		const store = new MemoryCredentialStore();
		const global: Credential = {
			type: "oauth",
			access: "global-access",
			refresh: "global-refresh",
			expires: 1,
		};
		const selected: Credential = {
			type: "oauth",
			access: "selected-access",
			refresh: "selected-refresh",
			expires: 2,
		};
		store.credentials.set("openai-codex", global);
		const selectedStorageId = codexCredentialStorageId("acct-alpha");
		store.credentials.set(selectedStorageId, selected);
		const scoped = scopedCredentialStore(store, "openai-codex:acct-alpha");

		expect(await scoped.read("openai-codex")).toEqual(selected);
		await scoped.modify("openai-codex", async (current) =>
			current?.type === "oauth" ? { ...current, access: "refreshed-access" } : undefined,
		);
		expect(await store.read(selectedStorageId)).toMatchObject({ access: "refreshed-access" });
		expect(await store.read("openai-codex")).toEqual(global);
	});
});
