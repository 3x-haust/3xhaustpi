import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ThreeXhaustCommand } from "./args.ts";
import { collectConnections, renderConnections } from "./connections.ts";
import type { CodexAccount, DeletedCodexAccount } from "./provider-accounts.ts";
import { addCodexAccount, deleteCodexAccount, resolveCodexAccount, selectCodexAccount } from "./provider-accounts.ts";
import { answerAuthPrompt } from "./provider-auth-prompt.ts";
import { createCredentialStore, loginProvider } from "./provider-runtime.ts";
import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

type AccountCommand = Extract<
	ThreeXhaustCommand,
	{ readonly kind: "account-list" | "account-add" | "account-use" | "account-delete" }
>;

const CODEX_PROVIDER = "openai-codex";

export async function deleteConfirmedCodexAccount(
	store: CredentialStore,
	selector: string,
	confirm: (account: CodexAccount) => Promise<boolean>,
): Promise<DeletedCodexAccount | undefined> {
	const account = await resolveCodexAccount(store, selector);
	if (!(await confirm(account))) return undefined;
	return deleteCodexAccount(store, account.accountId);
}

async function printInventory(): Promise<void> {
	console.log(sanitizeTerminalText(renderConnections(await collectConnections())));
}

export async function runAccountCommand(command: AccountCommand): Promise<void> {
	const store = createCredentialStore();
	if (command.kind === "account-list") return printInventory();
	if (command.kind === "account-add") {
		const provider = command.provider ?? CODEX_PROVIDER;
		if (provider === CODEX_PROVIDER || provider === "codex") {
			if (command.authType && command.authType !== "oauth") {
				throw new Error("OpenAI Codex supports OAuth login only");
			}
			const account = await addCodexAccount(store, () => loginProvider(CODEX_PROVIDER));
			console.log(sanitizeTerminalText(`Added and selected ${account.label}.`));
		} else {
			await loginProvider(provider, command.authType);
		}
		return printInventory();
	}
	if (command.kind === "account-use") {
		const account = await selectCodexAccount(store, command.selector);
		console.log(sanitizeTerminalText(`Selected ${account.label}.`));
		return printInventory();
	}
	const result = await deleteConfirmedCodexAccount(store, command.selector, async (account) => {
		const confirmation = await answerAuthPrompt({
			type: "text",
			message: `Delete ${account.label}? Type yes to confirm`,
		});
		return confirmation.trim().toLowerCase() === "yes";
	});
	if (!result) {
		console.log("Account deletion cancelled.");
		return;
	}
	console.log(sanitizeTerminalText(`Deleted ${result.deleted.label}.`));
	return printInventory();
}
