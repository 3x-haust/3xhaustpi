import { eligibleModelAccounts, resolveSessionAccount } from "./account-selection.ts";
import { collectProviderConnections, type ProviderConnection } from "./connections.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiAuxiliaryModelBinding } from "./tui-side-chat-types.ts";

export async function resolveTuiAuxiliaryBinding(
	core: TuiLiveCore,
	identity: string,
	collectConnections: () => Promise<readonly ProviderConnection[]> = collectProviderConnections,
): Promise<TuiAuxiliaryModelBinding> {
	const accounts = (await collectConnections()).flatMap(({ accounts }) => accounts);
	const exclusions = core.database.listTuiAccountExclusions(core.state.projectRoot);
	const pinned = core.database.findTuiProviderAccount(core.state.projectRoot, core.state.provider);
	const eligible = eligibleModelAccounts(accounts, exclusions);
	const account =
		eligible.find(({ id, providerId }) => id === pinned && providerId === core.state.provider) ??
		resolveSessionAccount(accounts, exclusions, core.state.provider, identity);
	if (!account) {
		throw new Error(`No selected account for ${core.state.provider}. Open /account to connect or enable one.`);
	}
	return {
		provider: core.state.provider,
		model: core.state.model,
		accountId: account.id,
		thinkingLevel: core.state.thinkingLevel,
	};
}
