import { createHash } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_ACCOUNT_PREFIX = `${CODEX_PROVIDER}.account.`;

export interface CodexAccount {
	readonly accountId: string;
	readonly label: string;
	readonly active: boolean;
}

export interface DeletedCodexAccount {
	readonly deleted: CodexAccount;
	readonly active?: CodexAccount;
}

export type CodexLogin = () => Promise<void>;

export class CodexAccountError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexAccountError";
	}
}

function field(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	for (const [candidate, entry] of Object.entries(value)) {
		if (candidate === key) return entry;
	}
	return undefined;
}

function jwtPayload(access: string): unknown {
	const encoded = access.split(".")[1];
	if (!encoded) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		return parsed;
	} catch (cause) {
		if (cause instanceof SyntaxError) return undefined;
		throw cause;
	}
}

function accountIdOf(credential: Credential | undefined): string | undefined {
	if (credential?.type !== "oauth") return undefined;
	if (typeof credential.accountId === "string" && credential.accountId.length > 0) return credential.accountId;
	const auth = field(jwtPayload(credential.access), "https://api.openai.com/auth");
	const accountId = field(auth, "chatgpt_account_id");
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function emailOf(credential: Credential): string | undefined {
	if (credential.type !== "oauth") return undefined;
	if (typeof credential.email === "string" && credential.email.includes("@")) return credential.email;
	const payload = jwtPayload(credential.access);
	const direct = field(payload, "email");
	if (typeof direct === "string" && direct.includes("@")) return direct;
	const profile = field(payload, "https://api.openai.com/profile");
	const nested = field(profile, "email");
	return typeof nested === "string" && nested.includes("@") ? nested : undefined;
}

export function codexCredentialStorageId(accountId: string): string {
	const digest = createHash("sha256").update(accountId).digest("hex").slice(0, 32);
	return `${CODEX_ACCOUNT_PREFIX}${digest}`;
}

function accountOf(credential: Credential, activeAccountId: string | undefined): CodexAccount | undefined {
	const accountId = accountIdOf(credential);
	if (!accountId) return undefined;
	const email = emailOf(credential);
	return {
		accountId,
		label: sanitizeTerminalText(email ?? `Codex account · ${accountId.slice(-8)}`)
			.replace(/\s+/gu, " ")
			.trim(),
		active: accountId === activeAccountId,
	};
}

function sameCredential(left: Credential | undefined, right: Credential): boolean {
	if (left?.type !== right.type) return false;
	if (left.type === "api_key" && right.type === "api_key") {
		return left.key === right.key && JSON.stringify(left.env) === JSON.stringify(right.env);
	}
	if (left.type !== "oauth" || right.type !== "oauth") return false;
	return left.access === right.access && left.refresh === right.refresh && left.expires === right.expires;
}

function candidateCredentialIsNewer(current: Credential | undefined, candidate: Credential): boolean {
	if (!current) return true;
	if (current.type !== "oauth" || candidate.type !== "oauth") return false;
	return candidate.expires > current.expires;
}

async function synchronizeActiveAccount(store: CredentialStore): Promise<CodexAccount | undefined> {
	const credential = await store.read(CODEX_PROVIDER);
	if (!credential) return undefined;
	const account = accountOf(credential, accountIdOf(credential));
	if (!account) {
		throw new CodexAccountError("The active Codex OAuth credential has no account ID");
	}
	const canonical = await store.modify(codexCredentialStorageId(account.accountId), async (current) =>
		sameCredential(current, credential) || !candidateCredentialIsNewer(current, credential) ? undefined : credential,
	);
	if (canonical && candidateCredentialIsNewer(credential, canonical)) {
		await store.modify(CODEX_PROVIDER, async (current) => {
			if (!current || accountIdOf(current) !== account.accountId) return undefined;
			return candidateCredentialIsNewer(current, canonical) ? canonical : undefined;
		});
	}
	return account;
}

async function savedAccounts(
	store: CredentialStore,
	activeAccountId: string | undefined,
): Promise<readonly CodexAccount[]> {
	const entries = (await store.list()).filter(({ providerId }) => providerId.startsWith(CODEX_ACCOUNT_PREFIX));
	const credentials = await Promise.all(entries.map(({ providerId }) => store.read(providerId)));
	const accounts = new Map<string, CodexAccount>();
	for (const credential of credentials) {
		if (!credential) continue;
		const account = accountOf(credential, activeAccountId);
		if (account) accounts.set(account.accountId, account);
	}
	return [...accounts.values()].sort((left, right) => {
		if (left.active !== right.active) return left.active ? -1 : 1;
		return left.label.localeCompare(right.label, "en") || left.accountId.localeCompare(right.accountId, "en");
	});
}

export async function listCodexAccounts(store: CredentialStore): Promise<readonly CodexAccount[]> {
	const active = await synchronizeActiveAccount(store);
	return savedAccounts(store, active?.accountId);
}

function resolveAccount(accounts: readonly CodexAccount[], selector: string): CodexAccount {
	const index = Number.parseInt(selector, 10);
	if (String(index) === selector && index >= 1) {
		const account = accounts[index - 1];
		if (account) return account;
	}
	const exact = accounts.find(({ accountId }) => accountId === selector);
	if (exact) return exact;
	const suffixes = accounts.filter(({ accountId }) => accountId.endsWith(selector));
	const suffix = suffixes[0];
	if (suffixes.length === 1 && suffix) return suffix;
	throw new CodexAccountError(`Unknown Codex account: ${selector}`);
}

export async function resolveCodexAccount(store: CredentialStore, selector: string): Promise<CodexAccount> {
	return resolveAccount(await listCodexAccounts(store), selector);
}

export async function addCodexAccount(store: CredentialStore, login: CodexLogin): Promise<CodexAccount> {
	await listCodexAccounts(store);
	await login();
	const active = (await listCodexAccounts(store)).find((account) => account.active);
	if (!active) throw new CodexAccountError("Codex OAuth login did not save an active account");
	return active;
}

async function credentialFor(store: CredentialStore, accountId: string): Promise<Credential> {
	const credential = await store.read(codexCredentialStorageId(accountId));
	if (!credential) throw new CodexAccountError(`Credential unavailable for Codex account: ${accountId}`);
	return credential;
}

export async function selectCodexAccount(store: CredentialStore, selector: string): Promise<CodexAccount> {
	const selected = await resolveCodexAccount(store, selector);
	const credential = await credentialFor(store, selected.accountId);
	await store.modify(CODEX_PROVIDER, async () => credential);
	return { ...selected, active: true };
}

export async function deleteCodexAccount(store: CredentialStore, selector: string): Promise<DeletedCodexAccount> {
	const accounts = await listCodexAccounts(store);
	const deleted = resolveAccount(accounts, selector);
	const remaining = accounts.filter(({ accountId }) => accountId !== deleted.accountId);
	let active = remaining.find((account) => account.active);
	if (deleted.active) {
		const replacement = remaining[0];
		if (replacement) {
			const credential = await credentialFor(store, replacement.accountId);
			await store.modify(CODEX_PROVIDER, async () => credential);
			active = { ...replacement, active: true };
		} else {
			await store.delete(CODEX_PROVIDER);
			active = undefined;
		}
	}
	await store.delete(codexCredentialStorageId(deleted.accountId));
	return { deleted, ...(active ? { active } : {}) };
}
