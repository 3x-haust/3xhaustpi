import { describe, expect, it } from "vitest";
import { confirmedAccountId, type PendingAccountDeletion } from "../src/tui-live-account.ts";

describe("TUI account deletion confirmation", () => {
	it("rejects a direct confirmation that has no matching pending account", () => {
		expect(confirmedAccountId(undefined, "2")).toBeUndefined();
	});

	it("binds confirmation to the account ID shown before list ordering changes", () => {
		const pending: PendingAccountDeletion = {
			accountId: "acct-alpha",
			label: "alpha@example.com",
			selector: "2",
		};

		expect(confirmedAccountId(pending, "2")).toBe("acct-alpha");
		expect(confirmedAccountId(pending, "1")).toBeUndefined();
	});
});
