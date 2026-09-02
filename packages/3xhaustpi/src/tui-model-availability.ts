import { eligibleModelAccounts } from "./account-selection.ts";
import type { ProviderConnection } from "./connections.ts";

export interface EligibleProviderModelEntry {
	readonly provider: string;
	readonly model: string;
}

export function eligibleProviderModelEntries(
	providers: readonly ProviderConnection[],
	excludedAccountIds: readonly string[],
): readonly EligibleProviderModelEntry[] {
	const eligibleProviderIds = new Set(
		eligibleModelAccounts(
			providers.flatMap(({ accounts }) => accounts),
			excludedAccountIds,
		).map(({ providerId }) => providerId),
	);
	const seen = new Set<string>();
	const models: EligibleProviderModelEntry[] = [];
	for (const provider of providers) {
		if (!eligibleProviderIds.has(provider.id)) continue;
		for (const model of provider.modelIds) {
			const identity = `${provider.id}\0${model}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			models.push({ provider: provider.id, model });
		}
	}
	return models;
}
