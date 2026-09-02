import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAccount } from "../src/account-selection.ts";
import type { ProviderConnection } from "../src/connections.ts";
import { createTuiAutocompleteController } from "../src/tui-live-autocomplete.ts";
import { createTuiDesktopController } from "../src/tui-live-desktop.ts";
import { startSettings } from "../src/tui-live-settings.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { createTuiWorkspaceCommands } from "../src/tui-live-workspace.ts";
import { SettingsOverlay } from "../src/tui-settings-overlay.ts";
import { stripAnsi } from "../src/tui-text.ts";

const connectionFixture = vi.hoisted(
	(): {
		providers: ProviderConnection[];
	} => ({ providers: [] }),
);

vi.mock("../src/connections.ts", () => ({
	collectProviderConnections: () => Promise.resolve(connectionFixture.providers),
}));

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

describe("/settings compact terminals", () => {
	beforeEach(() => {
		connectionFixture.providers = [
			connection("openai-codex", ["gpt-5.6-terra"], [account("openai-codex:alpha", "openai-codex")]),
			connection("anthropic", ["claude-sonnet-4-6"], [], false),
		];
	});

	it("opens an actionable overlay at 80x12 instead of printing status", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-settings-command-"));
		const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		try {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
			Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
			});
			const view = createTuiLiveView(core);
			const workspace = createTuiWorkspaceCommands(core, view);
			const autocomplete = createTuiAutocompleteController(core, workspace);
			const desktop = createTuiDesktopController(core, view);

			await startSettings(core, view, autocomplete, desktop, "model");

			expect(core.ui.hasOverlay()).toBe(true);
			expect(core.transcriptEntries).toHaveLength(0);
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			if (rows) Object.defineProperty(process.stdout, "rows", rows);
			else Reflect.deleteProperty(process.stdout, "rows");
			if (columns) Object.defineProperty(process.stdout, "columns", columns);
			else Reflect.deleteProperty(process.stdout, "columns");
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders only models backed by enabled authenticated accounts", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-settings-models-"));
		try {
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
			});
			const view = createTuiLiveView(core);
			const workspace = createTuiWorkspaceCommands(core, view);
			const autocomplete = createTuiAutocompleteController(core, workspace);
			const desktop = createTuiDesktopController(core, view);
			let captured: SettingsOverlay | undefined;
			const showOverlay = core.ui.showOverlay.bind(core.ui);
			vi.spyOn(core.ui, "showOverlay").mockImplementation((component, options) => {
				if (component instanceof SettingsOverlay) captured = component;
				return showOverlay(component, options);
			});

			await startSettings(core, view, autocomplete, desktop, "model");

			if (!captured) throw new Error("Expected model settings overlay");
			expect(stripAnsi(captured.render(80).join("\n"))).toContain("openai-codex/gpt-5.6-terra");
			for (const character of "anthropic") captured.handleInput(character);
			const rendered = stripAnsi(captured.render(80).join("\n"));
			expect(rendered).not.toContain("anthropic/");
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
