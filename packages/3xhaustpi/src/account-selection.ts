import { createHash } from "node:crypto";

export interface ModelAccount {
	readonly id: string;
	readonly providerId: string;
	readonly label: string;
	readonly detail: string;
	readonly active: boolean;
}

export function eligibleModelAccounts(
	accounts: readonly ModelAccount[],
	excludedAccountIds: readonly string[],
): readonly ModelAccount[] {
	const excluded = new Set(excludedAccountIds);
	return accounts.filter(({ id }) => !excluded.has(id));
}

export function resolveSessionAccount(
	accounts: readonly ModelAccount[],
	excludedAccountIds: readonly string[],
	providerId: string,
	sessionSeed: string,
): ModelAccount | undefined {
	const eligible = eligibleModelAccounts(accounts, excludedAccountIds)
		.filter((account) => account.providerId === providerId)
		.sort((left, right) => left.id.localeCompare(right.id, "en"));
	if (eligible.length === 0) return undefined;
	const digest = createHash("sha256").update(sessionSeed).digest();
	return eligible[digest.readUInt32BE(0) % eligible.length];
}
