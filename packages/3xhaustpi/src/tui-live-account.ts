import { spawnSync } from "node:child_process";
import type { AuthEvent, AuthType } from "@earendil-works/pi-ai";
import { collectConnections, renderConnections, useAsideAccount } from "./connections.ts";
import { addCodexAccount, deleteCodexAccount, resolveCodexAccount, selectCodexAccount } from "./provider-accounts.ts";
import { createCredentialStore, createProviderRuntime } from "./provider-runtime.ts";
import { AccountManagerOverlay } from "./tui-account-overlay.ts";
import type { AccountManagerSnapshot } from "./tui-account-overlay-model.ts";
import { promptProviderAuth } from "./tui-auth-prompt.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { dim, failure, success, text, warning } from "./tui-text.ts";

const activeViews = new WeakSet<TuiLiveView>();
const pendingDeletions = new WeakMap<TuiLiveView, PendingAccountDeletion>();

export interface PendingAccountDeletion {
	readonly accountId: string;
	readonly label: string;
	readonly selector: string;
}

export function confirmedAccountId(pending: PendingAccountDeletion | undefined, selector: string): string | undefined {
	return pending?.selector === selector ? pending.accountId : undefined;
}

function openBrowser(url: string): void {
	if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
}

function reportAuthEvent(event: AuthEvent, providerName: string, view: TuiLiveView): void {
	if (event.type === "auth_url") {
		view.appendText(text(`Open the ${providerName} sign-in page in your browser:`));
		view.appendText(event.url);
		if (event.instructions) view.appendText(dim(event.instructions));
		openBrowser(event.url);
		return;
	}
	if (event.type === "device_code") {
		view.appendText(text(`Open the ${providerName} sign-in page in your browser:`));
		view.appendText(event.verificationUri);
		view.appendText(`Code: ${text(event.userCode)}`);
		openBrowser(event.verificationUri);
		return;
	}
	view.appendText(dim(event.message));
}

async function loginProviderInTui(
	providerId: string,
	authType: AuthType,
	core: TuiLiveCore,
	view: TuiLiveView,
): Promise<void> {
	const runtime = createProviderRuntime();
	const provider = runtime.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	await runtime.login(providerId, authType, {
		prompt: (prompt) => promptProviderAuth(core, prompt),
		notify: (event) => reportAuthEvent(event, provider.name, view),
	});
}

async function snapshot(core: TuiLiveCore): Promise<AccountManagerSnapshot> {
	return {
		inventory: await collectConnections(),
		excludedAccountIds: core.database.listTuiAccountExclusions(core.state.projectRoot),
	};
}

async function showAccounts(core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	const current = await snapshot(core);
	view.appendText(`Notice ${renderConnections(current.inventory, "/account", current.excludedAccountIds)}`);
}

function parseAuthType(value: string | undefined): AuthType | undefined {
	if (value === "oauth") return "oauth";
	if (value === "api-key" || value === "api_key") return "api_key";
	return undefined;
}

async function addProviderAccount(
	providerId: string,
	authType: AuthType | undefined,
	core: TuiLiveCore,
	view: TuiLiveView,
): Promise<void> {
	const runtime = createProviderRuntime();
	const provider = runtime.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const type = authType ?? (provider.auth.oauth ? "oauth" : "api_key");
	if (providerId === "openai-codex") {
		if (type !== "oauth") throw new Error("OpenAI Codex supports OAuth login only");
		await addCodexAccount(createCredentialStore(), () => loginProviderInTui(providerId, type, core, view));
		return;
	}
	await loginProviderInTui(providerId, type, core, view);
}

async function executeAccountCommand(argument: string, core: TuiLiveCore, view: TuiLiveView): Promise<void> {
	const parts = argument.split(/\s+/u).filter(Boolean);
	const action = parts[0] ?? "list";
	const store = createCredentialStore();
	if (action === "list" && parts.length <= 1) return showAccounts(core, view);
	if (action === "add" && parts.length <= 3) {
		const providerId = parts[1] ?? "openai-codex";
		const authType = parseAuthType(parts[2]);
		if (parts[2] && !authType) throw new Error("Auth method must be oauth or api-key");
		await addProviderAccount(providerId, authType, core, view);
		view.appendText(`${success("✓")} Connected ${text(providerId)}`);
		return showAccounts(core, view);
	}
	if (action === "use" && parts[1] && parts.length === 2) {
		const account = await selectCodexAccount(store, parts[1]);
		view.appendText(`${success("✓")} Selected ${text(account.label)}`);
		return showAccounts(core, view);
	}
	if (action === "aside" && parts[1] === "use" && parts[2] && parts.length === 3) {
		useAsideAccount(parts[2]);
		view.appendText(`${success("✓")} Selected Aside account ${text(parts[2])}`);
		return showAccounts(core, view);
	}
	if (action === "delete" && parts[1] && parts.length === 2) {
		const account = await resolveCodexAccount(store, parts[1]);
		pendingDeletions.set(view, { accountId: account.accountId, label: account.label, selector: parts[1] });
		view.appendText(warning(`Delete ${account.label}?`));
		view.appendText(dim(`Confirm with /account delete ${parts[1]} confirm`));
		return;
	}
	if (action === "delete" && parts[1] && parts[2] === "confirm" && parts.length === 3) {
		const accountId = confirmedAccountId(pendingDeletions.get(view), parts[1]);
		if (!accountId) {
			view.appendText(warning(`No pending deletion for account selector ${parts[1]}.`));
			view.appendText(dim(`Start with /account delete ${parts[1]}`));
			return;
		}
		pendingDeletions.delete(view);
		const result = await deleteCodexAccount(store, accountId);
		view.appendText(`${success("✓")} Deleted ${text(result.deleted.label)}`);
		return showAccounts(core, view);
	}
	view.appendText(
		warning(
			"Usage: /account [list | add <provider> [oauth|api-key] | use <number> | delete <number> | aside use <id>]",
		),
	);
}

export function startAccountCommand(argument: string, core: TuiLiveCore, view: TuiLiveView): void {
	if (activeViews.has(view)) {
		view.appendText(warning("An account operation is already running."));
		return;
	}
	activeViews.add(view);
	void executeAccountCommand(argument, core, view)
		.catch((cause) => view.appendText(failure(cause instanceof Error ? cause.message : String(cause))))
		.finally(() => activeViews.delete(view));
}

export function startAccountManager(core: TuiLiveCore, view: TuiLiveView): void {
	const columns = process.stdout.columns || 120;
	const rows = process.stdout.rows || 36;
	if (columns < 40 || rows < 10) {
		startAccountCommand("list", core, view);
		return;
	}
	if (activeViews.has(view)) {
		view.appendText(warning("An account operation is already running."));
		return;
	}
	activeViews.add(view);
	void snapshot(core)
		.then((initial) => {
			const store = createCredentialStore();
			let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
			const refresh = () => snapshot(core);
			const overlay = new AccountManagerOverlay(initial, {
				login: async (providerId, authType) => {
					await addProviderAccount(providerId, authType, core, view);
					return refresh();
				},
				setAccountsEnabled: async (accountIds, enabled) => {
					core.database.setTuiAccountsEnabled(core.state.projectRoot, accountIds, enabled);
					return refresh();
				},
				selectCodex: async (accountId) => {
					await selectCodexAccount(store, accountId);
					return refresh();
				},
				deleteCodex: async (accountId) => {
					await deleteCodexAccount(store, accountId);
					return refresh();
				},
				selectAside: async (id) => {
					useAsideAccount(id);
					return refresh();
				},
				close: () => handle?.hide(),
				invalidate: () => core.ui.requestRender(),
			});
			handle = core.ui.showOverlay(overlay, {
				width: Math.max(36, Math.min(76, columns - 4)),
				maxHeight: "40%",
				anchor: "top-center",
				margin: 2,
			});
		})
		.catch((cause) => view.appendText(failure(cause instanceof Error ? cause.message : String(cause))))
		.finally(() => activeViews.delete(view));
}
