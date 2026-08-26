import type { SelectItem, SelectList } from "@earendil-works/pi-tui";
import type { ModelAccount } from "./account-selection.ts";
import type { ProviderConnection } from "./connections.ts";
import type { AccountManagerSnapshot } from "./tui-account-overlay-model.ts";
import { codexAccountId, providerTargets, selectedAccountIds } from "./tui-account-overlay-model.ts";

interface SelectEntry {
	readonly item: SelectItem;
	readonly select: () => void;
}

export interface AccountSecondaryContext {
	readonly snapshot: AccountManagerSnapshot;
	readonly provider: (providerId: string) => ProviderConnection | undefined;
	readonly selectList: (items: readonly SelectEntry[], cancel: () => void) => SelectList;
	readonly showAccount: (account: ModelAccount) => void;
	readonly showProvider: (providerId: string) => void;
	readonly showModels: (provider: ProviderConnection) => void;
	readonly confirmDelete: (account: ModelAccount) => void;
	readonly backToMain: () => void;
	readonly runOperation: (
		progressLabel: string,
		successLabel: string,
		operation: () => Promise<AccountManagerSnapshot>,
	) => void;
	readonly deleteCodex: (accountId: string) => Promise<AccountManagerSnapshot>;
	readonly selectCodex: (accountId: string) => Promise<AccountManagerSnapshot>;
	readonly setAccountsEnabled: (accountIds: readonly string[], enabled: boolean) => Promise<AccountManagerSnapshot>;
	readonly login: (providerId: string, authType: "oauth" | "api_key") => Promise<AccountManagerSnapshot>;
	readonly selectAside: (id: string) => Promise<AccountManagerSnapshot>;
}

export function createProviderList(providerId: string, context: AccountSecondaryContext): SelectList {
	const provider = context.provider(providerId);
	if (!provider) return context.selectList([], context.backToMain);
	const targets = providerTargets(provider, selectedAccountIds(context.snapshot));
	return context.selectList(
		targets.map(({ item, target }) => ({
			item,
			select: () => {
				if (target.kind === "back") return context.backToMain();
				if (target.kind === "all-provider-accounts") {
					context.runOperation("Updating provider accounts", "Updated provider accounts", () =>
						context.setAccountsEnabled(target.accountIds, !target.enabled),
					);
					return;
				}
				if (target.kind === "account") return context.showAccount(target.account);
				if (target.kind === "login") {
					context.runOperation(`Connecting ${provider.name}`, `Connected ${provider.name}`, () =>
						context.login(target.providerId, target.authType),
					);
					return;
				}
				context.showModels(target.provider);
			},
		})),
		context.backToMain,
	);
}

export function createAccountList(account: ModelAccount, context: AccountSecondaryContext): SelectList {
	const selected = selectedAccountIds(context.snapshot).has(account.id);
	const codexId = codexAccountId(account);
	const items: SelectItem[] = [
		{ value: "toggle", label: `${selected ? "☑" : "☐"} Use in this session`, description: "Enter to toggle" },
		...(codexId && !account.active
			? [{ value: "use", label: "Use as global default", description: "For CLI and new sessions" }]
			: []),
		...(codexId ? [{ value: "delete", label: "Delete account", description: "Requires confirmation" }] : []),
		{ value: "back", label: "Back" },
	];
	const back = () => context.showProvider(account.providerId);
	return context.selectList(
		items.map((item) => ({
			item,
			select: () => {
				if (item.value === "back") return back();
				if (item.value === "toggle") {
					context.runOperation("Updating session account", "Updated session account", () =>
						context.setAccountsEnabled([account.id], !selected),
					);
					return;
				}
				if (item.value === "use" && codexId) {
					context.runOperation(`Selecting ${account.label}`, `Selected ${account.label}`, () =>
						context.selectCodex(codexId),
					);
					return;
				}
				context.confirmDelete(account);
			},
		})),
		back,
	);
}

export function createDeleteConfirmationList(account: ModelAccount, context: AccountSecondaryContext): SelectList {
	const accountId = codexAccountId(account);
	const back = () => context.showAccount(account);
	const items: SelectItem[] = [
		{ value: "cancel", label: "Cancel", description: "Keep this account" },
		{ value: "delete", label: "Delete permanently", description: "Cannot be undone" },
	];
	return context.selectList(
		items.map((item) => ({
			item,
			select: () => {
				if (item.value === "cancel" || !accountId) return back();
				context.runOperation(`Deleting ${account.label}`, `Deleted ${account.label}`, () =>
					context.deleteCodex(accountId),
				);
			},
		})),
		back,
	);
}

export function createModelsList(provider: ProviderConnection, context: AccountSecondaryContext): SelectList {
	const items: SelectItem[] = [
		...provider.modelIds.map((id) => ({ value: `model:${id}`, label: id })),
		{ value: "back", label: "Back" },
	];
	const back = () => context.showProvider(provider.id);
	return context.selectList(
		items.map((item) => ({ item, select: back })),
		back,
	);
}

export function createConnectionsList(context: AccountSecondaryContext): SelectList {
	const items: SelectItem[] = [
		...context.snapshot.inventory.aside.map((account) => ({
			value: `aside:${account.id}`,
			label: `${account.selected ? "▶" : account.signedIn ? "●" : "○"} ${account.label}`,
			description: account.provider ?? account.id,
		})),
		{
			value: "back",
			label: "Back",
			description: `npm ${context.snapshot.inventory.npm.configured ? "connected" : "login required"}`,
		},
	];
	return context.selectList(
		items.map((item) => ({
			item,
			select: () => {
				if (item.value === "back") return context.backToMain();
				const id = item.value.slice("aside:".length);
				context.runOperation(`Selecting Aside account ${id}`, `Selected Aside account ${id}`, () =>
					context.selectAside(id),
				);
			},
		})),
		context.backToMain,
	);
}
