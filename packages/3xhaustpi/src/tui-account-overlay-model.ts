import type { AuthType } from "@earendil-works/pi-ai";
import type { SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import type { ModelAccount } from "./account-selection.ts";
import { type ConnectionInventory, modelAccounts, type ProviderConnection } from "./connections.ts";
import { accent, ellipsizeCells, muted, selection } from "./tui-text.ts";

export const ACCOUNT_SELECT_THEME: SelectListTheme = {
	selectedPrefix: accent,
	selectedText: selection,
	description: muted,
	scrollInfo: muted,
	noMatch: muted,
};

export interface AccountManagerSnapshot {
	readonly inventory: ConnectionInventory;
	readonly excludedAccountIds: readonly string[];
}

export type AccountMainTarget =
	| { readonly kind: "all-accounts"; readonly accountIds: readonly string[]; readonly enabled: boolean }
	| { readonly kind: "provider"; readonly provider: ProviderConnection }
	| { readonly kind: "connections" };

export type ProviderTarget =
	| { readonly kind: "all-provider-accounts"; readonly accountIds: readonly string[]; readonly enabled: boolean }
	| { readonly kind: "account"; readonly account: ModelAccount }
	| { readonly kind: "login"; readonly providerId: string; readonly authType: AuthType }
	| { readonly kind: "models"; readonly provider: ProviderConnection }
	| { readonly kind: "back" };

export function selectedAccountIds(snapshot: AccountManagerSnapshot): ReadonlySet<string> {
	const excluded = new Set(snapshot.excludedAccountIds);
	return new Set(
		modelAccounts(snapshot.inventory)
			.filter(({ id }) => !excluded.has(id))
			.map(({ id }) => id),
	);
}

export function accountMainTargets(snapshot: AccountManagerSnapshot): readonly {
	readonly item: SelectItem;
	readonly target: AccountMainTarget;
}[] {
	const accounts = modelAccounts(snapshot.inventory);
	const selected = selectedAccountIds(snapshot);
	const allEnabled = accounts.length > 0 && accounts.every(({ id }) => selected.has(id));
	return [
		{
			item: {
				value: "all-accounts",
				label: `${allEnabled ? "☑" : "☐"} All accounts`,
				description: `${selected.size}/${accounts.length} session`,
			},
			target: { kind: "all-accounts" as const, accountIds: accounts.map(({ id }) => id), enabled: allEnabled },
		},
		...snapshot.inventory.providers.map((provider) => {
			const providerSelected = provider.accounts.filter(({ id }) => selected.has(id)).length;
			const configured = provider.accounts.length > 0;
			return {
				item: {
					value: `provider:${provider.id}`,
					label: `${configured ? (providerSelected === provider.accounts.length ? "☑" : "☐") : "○"} ${provider.name}`,
					description: `${providerSelected}/${provider.accounts.length} · ${provider.modelCount} models`,
				},
				target: { kind: "provider" as const, provider },
			};
		}),
		{
			item: {
				value: "connections",
				label: "Other connections",
				description: `Aside ${snapshot.inventory.aside.length} · npm ${snapshot.inventory.npm.configured ? "connected" : "login"}`,
			},
			target: { kind: "connections" as const },
		},
	];
}

export function providerTargets(
	provider: ProviderConnection,
	selectedIds: ReadonlySet<string>,
): readonly { readonly item: SelectItem; readonly target: ProviderTarget }[] {
	const selectedCount = provider.accounts.filter(({ id }) => selectedIds.has(id)).length;
	const allEnabled = provider.accounts.length > 0 && selectedCount === provider.accounts.length;
	return [
		...(provider.accounts.length > 1
			? [
					{
						item: {
							value: "all-provider-accounts",
							label: `${allEnabled ? "☑" : "☐"} All ${provider.name} accounts`,
							description: `${selectedCount}/${provider.accounts.length} selected`,
						},
						target: {
							kind: "all-provider-accounts" as const,
							accountIds: provider.accounts.map(({ id }) => id),
							enabled: allEnabled,
						},
					},
				]
			: []),
		...provider.accounts.map((account) => ({
			item: {
				value: `account:${account.id}`,
				label: `${selectedIds.has(account.id) ? "☑" : "☐"} ${ellipsizeCells(account.label, 26)}`,
				description: account.detail,
			},
			target: { kind: "account" as const, account },
		})),
		...provider.authMethods
			.filter(({ interactive }) => interactive)
			.map((method) => ({
				item: {
					value: `login:${method.type}`,
					label: `+ ${method.type === "oauth" ? "Sign in with OAuth" : "Add API key"}`,
					description: method.label,
				},
				target: { kind: "login" as const, providerId: provider.id, authType: method.type },
			})),
		{
			item: {
				value: "models",
				label: `Models (${provider.modelCount})`,
				description: "View model IDs",
			},
			target: { kind: "models" as const, provider },
		},
		{ item: { value: "back", label: "Back" }, target: { kind: "back" as const } },
	];
}

export function codexAccountId(account: ModelAccount): string | undefined {
	return account.providerId === "openai-codex" && account.id.startsWith("openai-codex:")
		? account.id.slice("openai-codex:".length)
		: undefined;
}
