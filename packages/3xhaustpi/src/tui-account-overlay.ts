import type { AuthType } from "@earendil-works/pi-ai";
import { type Component, type Focusable, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import type { ModelAccount } from "./account-selection.ts";
import type { ProviderConnection } from "./connections.ts";
import {
	ACCOUNT_SELECT_THEME,
	type AccountManagerSnapshot,
	accountMainTargets,
	selectedAccountIds,
} from "./tui-account-overlay-model.ts";
import {
	type AccountSecondaryContext,
	createAccountList,
	createConnectionsList,
	createDeleteConfirmationList,
	createModelsList,
	createProviderList,
} from "./tui-account-overlay-secondary.ts";
import { accent, ellipsizeCells, failure, frameLine, muted, success, text } from "./tui-text.ts";

export interface AccountManagerActions {
	readonly login: (providerId: string, authType: AuthType) => Promise<AccountManagerSnapshot>;
	readonly setAccountsEnabled: (accountIds: readonly string[], enabled: boolean) => Promise<AccountManagerSnapshot>;
	readonly selectCodex: (accountId: string) => Promise<AccountManagerSnapshot>;
	readonly deleteCodex: (accountId: string) => Promise<AccountManagerSnapshot>;
	readonly selectAside: (id: string) => Promise<AccountManagerSnapshot>;
	readonly close: () => void;
	readonly invalidate: () => void;
}

type AccountManagerMode =
	| { readonly kind: "main" }
	| { readonly kind: "provider"; readonly providerId: string }
	| { readonly kind: "account"; readonly account: ModelAccount }
	| { readonly kind: "confirm-delete"; readonly account: ModelAccount }
	| { readonly kind: "models"; readonly provider: ProviderConnection }
	| { readonly kind: "connections" }
	| { readonly kind: "busy"; readonly label: string };

export class AccountManagerOverlay implements Component, Focusable {
	focused = false;
	private readonly actions: AccountManagerActions;
	private snapshot: AccountManagerSnapshot;
	private list: SelectList;
	private mode: AccountManagerMode = { kind: "main" };
	private status: { readonly kind: "success" | "failure"; readonly text: string } | undefined;
	private position = 1;
	private count = 0;

	constructor(snapshot: AccountManagerSnapshot, actions: AccountManagerActions) {
		this.snapshot = snapshot;
		this.actions = actions;
		this.list = this.createMainList();
	}

	render(width: number): string[] {
		const maxRows = Math.max(6, Math.floor((process.stdout.rows || 24) * 0.4));
		this.list.setMaxVisible(Math.max(1, maxRows - 6));
		this.list.setScrollInfoVisible(true);
		if (this.mode.kind === "busy") {
			return [
				frameLine(accent("Accounts"), width),
				frameLine(muted("Please wait"), width),
				" ".repeat(width),
				frameLine(text(this.mode.label), width),
			];
		}
		const compact = width < 56;
		const title = ellipsizeCells(this.title(compact), width);
		const hint = compact ? "↑↓ move · Enter · Esc" : "↑↓ navigate · Enter open/select · Esc back";
		const footer = this.status
			? this.status.kind === "success"
				? success(this.status.text)
				: failure(this.status.text)
			: muted(this.footer(compact));
		return [
			frameLine(accent(title), width),
			frameLine(muted(hint), width),
			" ".repeat(width),
			...this.list.render(width),
			" ".repeat(width),
			frameLine(footer, width),
		];
	}

	handleInput(data: string): void {
		if (this.mode.kind !== "busy") this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private title(compact: boolean): string {
		if (this.mode.kind === "main") return compact ? `Accounts · ${this.position}/${this.count}` : "Accounts";
		if (this.mode.kind === "provider") return this.provider(this.mode.providerId)?.name ?? "Provider";
		if (this.mode.kind === "models") return `${this.mode.provider.name} models`;
		if (this.mode.kind === "connections") return "Other connections";
		if (this.mode.kind === "confirm-delete") return `Delete ${this.mode.account.label}?`;
		if (this.mode.kind === "busy") return "Accounts";
		return this.mode.account.label;
	}

	private footer(compact: boolean): string {
		const selected = selectedAccountIds(this.snapshot).size;
		const total = this.snapshot.inventory.providers.flatMap(({ accounts }) => accounts).length;
		if (this.mode.kind === "confirm-delete") return "Cancel is selected by default";
		if (this.mode.kind === "models") return `${this.mode.provider.modelCount} models · read only`;
		return compact ? `${selected}/${total} selected` : `${selected}/${total} accounts selected for this session`;
	}

	private provider(providerId: string): ProviderConnection | undefined {
		return this.snapshot.inventory.providers.find(({ id }) => id === providerId);
	}

	private selectList(
		items: readonly { readonly item: SelectItem; readonly select: () => void }[],
		cancel: () => void,
	): SelectList {
		this.position = 1;
		this.count = items.length;
		const actions = new Map(items.map(({ item, select }) => [item.value, select]));
		const list = new SelectList(
			items.map(({ item }) => item),
			8,
			ACCOUNT_SELECT_THEME,
			{ minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 36 },
		);
		list.onSelectionChange = (item) => {
			const index = items.findIndex(({ item: candidate }) => candidate.value === item.value);
			if (index >= 0) this.position = index + 1;
			this.actions.invalidate();
		};
		list.onSelect = (item) => actions.get(item.value)?.();
		list.onCancel = cancel;
		return list;
	}

	private createMainList(): SelectList {
		const targets = accountMainTargets(this.snapshot);
		return this.selectList(
			targets.map(({ item, target }) => ({
				item,
				select: () => {
					if (target.kind === "all-accounts") {
						this.runOperation(
							target.enabled ? "Clearing session accounts" : "Selecting all accounts",
							"Updated session accounts",
							() => this.actions.setAccountsEnabled(target.accountIds, !target.enabled),
						);
					} else if (target.kind === "provider") {
						this.mode = { kind: "provider", providerId: target.provider.id };
						this.list = createProviderList(target.provider.id, this.secondaryContext());
						this.actions.invalidate();
					} else {
						this.mode = { kind: "connections" };
						this.list = createConnectionsList(this.secondaryContext());
						this.actions.invalidate();
					}
				},
			})),
			this.actions.close,
		);
	}

	private secondaryContext(): AccountSecondaryContext {
		return {
			snapshot: this.snapshot,
			provider: (providerId) => this.provider(providerId),
			selectList: (items, cancel) => this.selectList(items, cancel),
			showAccount: (account) => {
				this.mode = { kind: "account", account };
				this.list = createAccountList(account, this.secondaryContext());
				this.actions.invalidate();
			},
			showProvider: (providerId) => {
				this.mode = { kind: "provider", providerId };
				this.list = createProviderList(providerId, this.secondaryContext());
				this.actions.invalidate();
			},
			showModels: (provider) => {
				this.mode = { kind: "models", provider };
				this.list = createModelsList(provider, this.secondaryContext());
				this.actions.invalidate();
			},
			confirmDelete: (account) => {
				this.mode = { kind: "confirm-delete", account };
				this.list = createDeleteConfirmationList(account, this.secondaryContext());
				this.actions.invalidate();
			},
			backToMain: () => this.backToMain(),
			runOperation: (progress, complete, operation) => this.runOperation(progress, complete, operation),
			deleteCodex: this.actions.deleteCodex,
			selectCodex: this.actions.selectCodex,
			setAccountsEnabled: this.actions.setAccountsEnabled,
			login: this.actions.login,
			selectAside: this.actions.selectAside,
		};
	}

	private backToMain(): void {
		this.mode = { kind: "main" };
		this.list = this.createMainList();
		this.actions.invalidate();
	}

	private runOperation(
		progressLabel: string,
		successLabel: string,
		operation: () => Promise<AccountManagerSnapshot>,
	): void {
		this.mode = { kind: "busy", label: progressLabel };
		this.status = undefined;
		this.actions.invalidate();
		void operation()
			.then((snapshot) => {
				this.snapshot = snapshot;
				this.mode = { kind: "main" };
				this.status = { kind: "success", text: successLabel };
				this.list = this.createMainList();
				this.actions.invalidate();
			})
			.catch((cause) => {
				this.mode = { kind: "main" };
				this.status = { kind: "failure", text: cause instanceof Error ? cause.message : String(cause) };
				this.list = this.createMainList();
				this.actions.invalidate();
			});
	}
}
