import { describe, expect, it } from "vitest";
import { renderConnections } from "../src/connections.ts";

describe("readable account inventory", () => {
	it("shows Codex OAuth accounts first with numbered account actions", () => {
		const inventory = {
			providers: [
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					modelCount: 7,
					modelIds: ["gpt-5.6-terra"],
					configured: true,
					credentialType: "oauth" as const,
					authMethods: [{ type: "oauth" as const, label: "OpenAI subscription", interactive: true }],
					accounts: [
						{
							id: "openai-codex:acct-alpha-12345678",
							providerId: "openai-codex",
							label: "alpha@example.com",
							detail: "active OAuth",
							active: true,
						},
						{
							id: "openai-codex:acct-beta-87654321",
							providerId: "openai-codex",
							label: "beta@example.com",
							detail: "saved OAuth",
							active: false,
						},
					],
				},
				{
					id: "anthropic",
					name: "Anthropic",
					modelCount: 13,
					modelIds: ["claude-opus-4-7"],
					configured: false,
					authMethods: [
						{ type: "oauth" as const, label: "Claude subscription", interactive: true },
						{ type: "api_key" as const, label: "Anthropic API key", interactive: true },
					],
					accounts: [],
				},
			],
			aside: [],
			npm: {
				configured: false,
				registry: "https://registry.npmjs.org/",
			},
		};

		const rendered = renderConnections(inventory, "/account");

		expect(rendered).toContain("OpenAI Codex");
		expect(rendered).toContain("2 accounts · OAuth · 7 models");
		expect(rendered).toContain("☑ 1  alpha@example.com");
		expect(rendered).toContain("☑ 2  beta@example.com");
		expect(rendered).toContain("/account add openai-codex oauth");
		expect(rendered).toContain("Anthropic");
		expect(rendered).toContain("OAuth + API key · 13 models");
		expect(rendered).toContain("/account use <n>");
		expect(rendered).toContain("/account delete <n>");
		expect(rendered.indexOf("OpenAI Codex")).toBeLessThan(rendered.indexOf("Anthropic"));
	});
});
