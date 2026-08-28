import { describe, expect, it } from "vitest";
import { parseAsideAccounts } from "../src/aside-accounts.ts";

describe("Aside accounts", () => {
	it("parses signed-in and selected accounts", () => {
		expect(
			parseAsideAccounts(
				"* u0  user@example.com  signed in  profiles: Profile 0\n  provider: google\n  u1  Local Account  signed out  profiles: Profile 1",
			),
		).toEqual([
			{ id: "u0", label: "user@example.com", provider: "google", signedIn: true, selected: true },
			{ id: "u1", label: "Local Account", signedIn: false, selected: false },
		]);
	});
});
