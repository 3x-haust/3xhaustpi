import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAccount } from "../src/account-selection.ts";
import type { ProviderConnection } from "../src/connections.ts";
import { createTuiAutocompleteController } from "../src/tui-live-autocomplete.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { createTuiWorkspaceCommands } from "../src/tui-live-workspace.ts";

const connectionFixture = vi.hoisted(
	(): {
		providers: ProviderConnection[];
	} => ({ providers: [] }),
);

vi.mock("../src/connections.ts", () => ({
	collectProviderConnections: () => Promise.resolve(connectionFixture.providers),
}));

const cleanups: Array<() => void> = [];

beforeEach(() => {
	connectionFixture.providers = [];
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function account(id: string, providerId: string): ModelAccount {
	return {
		id,
		providerId,
		label: id,
		detail: "test",
		active: true,
	};
}

function connection(
	id: string,
	modelIds: readonly string[],
	accounts: readonly ModelAccount[],
	configured = accounts.length > 0,
): ProviderConnection {
	return {
		id,
		name: id,
		modelCount: modelIds.length,
		modelIds,
		authMethods: [],
		configured,
		accounts,
	};
}

function controller(provider: string) {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-model-visibility-"));
	const projectRoot = join(root, "project");
	const core = createTuiLiveCore({
		projectRoot,
		statePath: join(root, "state.sqlite"),
		runTask: async () => undefined,
		resumeTask: async () => undefined,
	});
	const view = createTuiLiveView(core);
	core.state.provider = provider;
	const autocomplete = createTuiAutocompleteController(core, createTuiWorkspaceCommands(core, view));
	cleanups.push(() => {
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { autocomplete, core, projectRoot };
}

describe("authenticated model visibility", () => {
	it("hides current-provider models when its only account is disabled", async () => {
		connectionFixture.providers = [
			connection("anthropic", ["claude-sonnet-4-6"], [account("provider:anthropic", "anthropic")]),
		];
		const { autocomplete, core, projectRoot } = controller("anthropic");
		core.database.setTuiAccountsEnabled(projectRoot, ["provider:anthropic"], false);

		expect(await autocomplete.currentProviderModels()).toEqual([]);
	});

	it("shows each declared model for a provider with an enabled authenticated account", async () => {
		connectionFixture.providers = [
			connection("openai-codex", ["gpt-5.6-terra"], [account("openai-codex:alpha", "openai-codex")]),
		];
		const { autocomplete } = controller("openai-codex");

		expect((await autocomplete.currentProviderModels()).map(({ id }) => id)).toEqual(["gpt-5.6-terra"]);
	});

	it("does not treat supported authentication methods as a logged-in account", async () => {
		connectionFixture.providers = [
			{
				...connection("anthropic", ["claude-sonnet-4-6"], [], false),
				authMethods: [{ type: "api_key", label: "Anthropic API key", interactive: true }],
			},
		];
		const { autocomplete } = controller("anthropic");

		expect(await autocomplete.currentProviderModels()).toEqual([]);
	});

	it("keeps provider models once while any one of several accounts remains enabled", async () => {
		connectionFixture.providers = [
			connection(
				"openai-codex",
				["gpt-5.6-terra"],
				[account("openai-codex:alpha", "openai-codex"), account("openai-codex:beta", "openai-codex")],
			),
		];
		const { autocomplete, core, projectRoot } = controller("openai-codex");
		core.database.setTuiAccountsEnabled(projectRoot, ["openai-codex:alpha"], false);

		expect((await autocomplete.currentProviderModels()).map(({ id }) => id)).toEqual(["gpt-5.6-terra"]);
		core.database.setTuiAccountsEnabled(projectRoot, ["openai-codex:beta"], false);
		expect(await autocomplete.currentProviderModels()).toEqual([]);
	});

	it("returns no selectable models when no provider has an eligible account", async () => {
		connectionFixture.providers = [
			connection("anthropic", ["claude-sonnet-4-6"], [], false),
			connection("openai-codex", ["gpt-5.6-terra"], [], false),
		];
		const { autocomplete } = controller("openai-codex");

		expect(await autocomplete.currentProviderModels()).toEqual([]);
	});
});
