export interface AsideAccount {
	readonly id: string;
	readonly label: string;
	readonly provider?: string;
	readonly signedIn: boolean;
	readonly selected: boolean;
}

export function parseAsideAccounts(output: string): readonly AsideAccount[] {
	const accounts: AsideAccount[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match = /^(\*|\s)\s+(u\d+)\s+(.+?)\s{2}(signed in|signed out)\s{2}profiles:/u.exec(line);
		if (match) {
			accounts.push({
				id: match[2]!,
				label: match[3]!.trim(),
				signedIn: match[4] === "signed in",
				selected: match[1] === "*",
			});
			continue;
		}
		const provider = /^\s+provider:\s+(.+)$/u.exec(line)?.[1];
		if (provider && accounts.length > 0) {
			const account = accounts.at(-1)!;
			accounts[accounts.length - 1] = { ...account, provider: provider.trim() };
		}
	}
	return accounts;
}
