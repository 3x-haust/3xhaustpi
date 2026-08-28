import { spawnSync } from "node:child_process";
import type { ModelAccount } from "./account-selection.ts";
import { eligibleModelAccounts } from "./account-selection.ts";
import { type AsideAccount, parseAsideAccounts } from "./aside-accounts.ts";
import { listCodexAccounts } from "./provider-accounts.ts";
import {
	collectProviderStatuses,
	createCredentialStore,
	type ProviderAuthMethod,
	type ProviderStatus,
} from "./provider-runtime.ts";

export interface ProviderConnection extends ProviderStatus {
	readonly accounts: readonly ModelAccount[];
}

export interface ConnectionInventory {
	readonly providers: readonly ProviderConnection[];
	readonly aside: readonly AsideAccount[];
	readonly npm: {
		readonly account?: string;
		readonly configured: boolean;
		readonly registry: string;
	};
}

function command(
	command: string,
	args: readonly string[],
): { readonly status: number | null; readonly output: string } {
	const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 });
	return { status: result.status, output: result.stdout.trim() };
}

export async function collectConnections(): Promise<ConnectionInventory> {
	const providers = await collectProviderConnections();
	const aside = command("aside", ["account", "list"]);
	const npm = command("npm", ["whoami"]);
	const registry = command("npm", ["config", "get", "registry"]);
	return {
		providers,
		aside: aside.status === 0 ? parseAsideAccounts(aside.output) : [],
		npm: {
			...(npm.status === 0 && npm.output ? { account: npm.output } : {}),
			configured: npm.status === 0,
			registry: registry.status === 0 ? registry.output : "https://registry.npmjs.org/",
		},
	};
}

export async function collectProviderConnections(): Promise<readonly ProviderConnection[]> {
	const [statuses, codexAccounts] = await Promise.all([
		collectProviderStatuses(),
		listCodexAccounts(createCredentialStore()),
	]);
	return statuses
		.map(
			(status): ProviderConnection => ({
				...status,
				accounts:
					status.id === "openai-codex"
						? codexAccounts.map((account) => ({
								id: `openai-codex:${account.accountId}`,
								providerId: status.id,
								label: account.label,
								detail: `${account.active ? "active" : "saved"} OAuth`,
								active: account.active,
							}))
						: status.configured
							? [
									{
										id: `provider:${status.id}`,
										providerId: status.id,
										label:
											status.authMethods.find(({ type }) => type === status.credentialType)?.label ??
											status.name,
										detail: status.source ?? (status.credentialType === "oauth" ? "OAuth" : "API key"),
										active: true,
									},
								]
							: [],
			}),
		)
		.sort(
			(left, right) =>
				Number(right.configured) - Number(left.configured) ||
				left.name.localeCompare(right.name, "en") ||
				left.id.localeCompare(right.id, "en"),
		);
}

export function modelAccounts(inventory: ConnectionInventory): readonly ModelAccount[] {
	return inventory.providers.flatMap(({ accounts }) => accounts);
}

export function useAsideAccount(id: string): void {
	if (!/^u\d+$/u.test(id)) throw new Error(`Invalid Aside account id: ${id}`);
	const result = spawnSync("aside", ["account", "use", id], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0)
		throw new Error(`${result.stdout}${result.stderr}`.trim() || "Aside account selection failed");
}

export function compactAccountId(accountId: string): string {
	return accountId.length <= 18 ? accountId : `…${accountId.slice(-12)}`;
}

function authSummary(methods: readonly ProviderAuthMethod[]): string {
	const labels = methods.map(({ type }) => (type === "oauth" ? "OAuth" : "API key"));
	return labels.join(" + ") || "Ambient credentials";
}

export function renderConnections(
	inventory: ConnectionInventory,
	accountCommand = "account",
	excludedAccountIds: readonly string[] = [],
): string {
	const accounts = modelAccounts(inventory);
	const eligible = new Set(eligibleModelAccounts(accounts, excludedAccountIds).map(({ id }) => id));
	const lines = [`Accounts · ${inventory.providers.length} providers · ${eligible.size}/${accounts.length} selected`];
	for (const provider of inventory.providers) {
		lines.push(
			"",
			`${provider.configured ? "●" : "○"} ${provider.name}  ${provider.accounts.length ? `${provider.accounts.length} account${provider.accounts.length === 1 ? "" : "s"} · ` : ""}${authSummary(provider.authMethods)} · ${provider.modelCount} models`,
		);
		for (const [index, account] of provider.accounts.entries()) {
			const codexNumber = provider.id === "openai-codex" ? `${index + 1}  ` : "";
			lines.push(`  ${eligible.has(account.id) ? "☑" : "☐"} ${codexNumber}${account.label}`);
			lines.push(`       ${account.detail} · ${compactAccountId(account.id.split(":").slice(1).join(":"))}`);
		}
		for (const method of provider.authMethods.filter(({ interactive }) => interactive)) {
			lines.push(`  ${accountCommand} add ${provider.id} ${method.type === "api_key" ? "api-key" : "oauth"}`);
		}
		if (provider.error) lines.push(`  × ${provider.error}`);
	}
	lines.push(`  ${accountCommand} use <n> · ${accountCommand} delete <n>`);
	lines.push("", `Aside browser accounts ${inventory.aside.filter(({ signedIn }) => signedIn).length}`);
	if (inventory.aside.length === 0) lines.push("  ○ No Aside accounts");
	for (const account of inventory.aside) {
		lines.push(
			`  ${account.selected ? "▶" : account.signedIn ? "●" : "○"} ${account.id}  ${account.label}${account.provider ? `  ${account.provider}` : ""}`,
		);
	}
	if (inventory.aside.length > 0) lines.push(`  ${accountCommand} aside use <id>`);
	return lines.join("\n");
}
