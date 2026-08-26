import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTuiAutocompleteController } from "../src/tui-live-autocomplete.ts";
import { createTuiDesktopController } from "../src/tui-live-desktop.ts";
import { startSettings } from "../src/tui-live-settings.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { createTuiWorkspaceCommands } from "../src/tui-live-workspace.ts";

describe("/settings compact terminals", () => {
	it("opens an actionable overlay at 80x12 instead of printing status", () => {
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

			startSettings(core, view, autocomplete, desktop, "model");

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
});
