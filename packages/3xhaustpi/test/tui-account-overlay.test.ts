import { describe, expect, it } from "vitest";
import type { ConnectionInventory } from "../src/connections.ts";
import { type AccountManagerActions, AccountManagerOverlay } from "../src/tui-account-overlay.ts";
import { type AccountManagerSnapshot, providerTargets } from "../src/tui-account-overlay-model.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

const inventory: ConnectionInventory = {
	providers: [
		{
			id: "openai-codex",
			name: "OpenAI Codex",
			modelCount: 2,
			modelIds: ["gpt-5.6-terra", "gpt-5.6-sol"],
			configured: true,
			credentialType: "oauth",
			authMethods: [{ type: "oauth", label: "OpenAI subscription", interactive: true }],
			accounts: [
				{
					id: "openai-codex:acct-beta",
					providerId: "openai-codex",
					label: "beta@example.com",
					detail: "active OAuth",
					active: true,
				},
				{
					id: "openai-codex:acct-alpha",
					providerId: "openai-codex",
					label: "alpha@example.com",
					detail: "saved OAuth",
					active: false,
				},
			],
		},
		{
			id: "anthropic",
			name: "Anthropic",
			modelCount: 1,
			modelIds: ["claude-opus-4-7"],
			configured: false,
			authMethods: [
				{ type: "oauth", label: "Claude subscription", interactive: true },
				{ type: "api_key", label: "Anthropic API key", interactive: true },
			],
			accounts: [],
		},
	],
	aside: [{ id: "u0", label: "aside@example.com", provider: "google", signedIn: true, selected: false }],
	npm: { account: "publisher", configured: true, registry: "https://registry.npmjs.org/" },
};

const initial: AccountManagerSnapshot = { inventory, excludedAccountIds: [] };

function harness(): {
	readonly actions: AccountManagerActions;
	readonly enabled: Array<{ readonly ids: readonly string[]; readonly value: boolean }>;
	readonly logins: Array<{ readonly providerId: string; readonly authType: "oauth" | "api_key" }>;
	readonly deletedCodex: string[];
} {
	const enabled: Array<{ readonly ids: readonly string[]; readonly value: boolean }> = [];
	const logins: Array<{ readonly providerId: string; readonly authType: "oauth" | "api_key" }> = [];
	const deletedCodex: string[] = [];
	return {
		enabled,
		logins,
		deletedCodex,
		actions: {
			login: async (providerId, authType) => {
				logins.push({ providerId, authType });
				return initial;
			},
			setAccountsEnabled: async (ids, value) => {
				enabled.push({ ids, value });
				return initial;
			},
			selectCodex: async () => initial,
			deleteCodex: async (accountId) => {
				deletedCodex.push(accountId);
				return initial;
			},
			selectAside: async () => initial,
			close: () => {},
			invalidate: () => {},
		},
	};
}

describe("AccountManagerOverlay", () => {
	it("groups accounts under providers with a default-all session checkbox", () => {
		const overlay = new AccountManagerOverlay(initial, harness().actions);
		const rendered = stripAnsi(overlay.render(72).join("\n"));

		expect(rendered).toContain("☑ All accounts");
		expect(rendered).toContain("☑ OpenAI Codex");
		expect(rendered).toContain("○ Anthropic");
		expect(rendered).toContain("2/2 accounts selected for this session");
	});

	it("clears every account from the global checkbox", () => {
		const context = harness();
		const overlay = new AccountManagerOverlay(initial, context.actions);

		overlay.handleInput("\r");

		expect(context.enabled).toEqual([
			{
				ids: ["openai-codex:acct-beta", "openai-codex:acct-alpha"],
				value: false,
			},
		]);
	});

	it("opens provider depth with account, auth, and model rows", () => {
		const overlay = new AccountManagerOverlay(initial, harness().actions);

		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");

		const rendered = stripAnsi(overlay.render(72).join("\n"));
		expect(rendered).toContain("OpenAI Codex");
		expect(rendered).toContain("☑ All OpenAI Codex accounts");
		expect(rendered).toContain("☑ beta@example.com");

		overlay.handleInput("\x1b[B");
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\x1b[B");
		expect(stripAnsi(overlay.render(72).join("\n"))).toContain("+ Sign in with OAuth");
		overlay.handleInput("\x1b[B");
		expect(stripAnsi(overlay.render(72).join("\n"))).toContain("Models (2)");
	});

	it("opens an API-key login from an unconfigured provider", () => {
		const context = harness();
		const overlay = new AccountManagerOverlay(initial, context.actions);

		overlay.handleInput("\x1b[B");
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");

		expect(context.logins).toEqual([{ providerId: "anthropic", authType: "api_key" }]);
	});

	it("keeps every rendered row within a compact overlay", () => {
		const overlay = new AccountManagerOverlay(initial, harness().actions);
		const lines = overlay.render(36);

		expect(stripAnsi(lines.join("\n"))).toContain("Accounts · 1/4");
		expect(lines.every((line) => cellWidth(stripAnsi(line)) <= 36)).toBe(true);
	});

	it("ellipsizes long CJK account labels before the compact list clips them", () => {
		const provider = inventory.providers[0];
		if (!provider) throw new Error("Expected provider fixture");
		const firstAccount = provider.accounts[0];
		if (!firstAccount) throw new Error("Expected account fixture");
		const targets = providerTargets(
			{
				...provider,
				accounts: [
					{
						...firstAccount,
						label: "非常に長い保存済みアカウント@example.com",
					},
				],
			},
			new Set(["openai-codex:acct-beta"]),
		);
		const account = targets.find(({ target }) => target.kind === "account");

		expect(account?.item.label).toContain("…");
		expect(cellWidth(account?.item.label ?? "")).toBeLessThanOrEqual(28);
	});
});
