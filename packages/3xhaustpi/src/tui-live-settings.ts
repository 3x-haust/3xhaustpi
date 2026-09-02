import { collectProviderConnections } from "./connections.ts";
import type { TuiAutocompleteController } from "./tui-live-autocomplete.ts";
import type { TuiDesktopController } from "./tui-live-desktop.ts";
import { startResourcesCommand, startSkillBrowser } from "./tui-live-resources.ts";
import { resetLiveContextTelemetry, type TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { eligibleProviderModelEntries } from "./tui-model-availability.ts";
import { SettingsOverlay, type SettingsOverlaySnapshot, type SettingsReasoningLevel } from "./tui-settings-overlay.ts";

async function snapshot(core: TuiLiveCore): Promise<SettingsOverlaySnapshot> {
	const models = eligibleProviderModelEntries(
		await collectProviderConnections(),
		core.database.listTuiAccountExclusions(core.state.projectRoot),
	);
	return {
		models,
		currentModel: { provider: core.state.provider, model: core.state.model },
		reasoning: core.state.thinkingLevel,
		cacheWarmEnabled: core.cacheWarm.snapshot().enabled,
	};
}

export async function startSettings(
	core: TuiLiveCore,
	view: TuiLiveView,
	autocomplete: TuiAutocompleteController,
	desktop: TuiDesktopController,
	initialDepth: "root" | "model" = "root",
): Promise<void> {
	const columns = process.stdout.columns || 120;
	if (columns < 40) {
		view.appendText(
			`Settings  ${core.state.provider}/${core.state.model} · ${core.state.thinkingLevel} · cache ${
				core.cacheWarm.snapshot().enabled ? "on" : "off"
			}`,
		);
		return;
	}
	let handle: ReturnType<TuiLiveCore["ui"]["showOverlay"]> | undefined;
	const closeThen = (action: () => void) => {
		handle?.hide();
		action();
	};
	const overlay = new SettingsOverlay(
		await snapshot(core),
		() => Math.max(1, Math.floor((process.stdout.rows || 36) * 0.4)),
		{
			selectModel: async ({ provider, model }) => {
				core.state.provider = provider;
				core.state.model = model;
				resetLiveContextTelemetry(core.state);
				autocomplete.installAutocomplete();
				view.updateChrome(`model ${model}`);
				return await snapshot(core);
			},
			selectReasoning: async (level: SettingsReasoningLevel) => {
				core.state.thinkingLevel = level;
				view.updateChrome(`reasoning ${level}`);
				return await snapshot(core);
			},
			setCacheWarm: async (enabled) => {
				core.database.setTuiProjectPreference(
					core.state.projectRoot,
					"cache-warm",
					enabled ? "eligible" : undefined,
				);
				core.cacheWarm.setEnabled(enabled);
				view.updateChrome(`cache warming ${enabled ? "on" : "off"}`);
				return await snapshot(core);
			},
			openSkills: () => closeThen(() => startSkillBrowser(core, view)),
			openMcpServers: () => closeThen(() => startResourcesCommand(core, view)),
			openHooks: () => closeThen(() => startResourcesCommand(core, view)),
			openComputerAccess: () => closeThen(() => desktop.startComputerCommand("apps")),
			close: () => handle?.hide(),
			invalidate: () => core.ui.requestRender(),
		},
		initialDepth,
	);
	handle = core.ui.showOverlay(overlay, {
		width: Math.max(36, Math.min(76, columns - 4)),
		maxHeight: "40%",
		anchor: "top-center",
		margin: 2,
	});
}
