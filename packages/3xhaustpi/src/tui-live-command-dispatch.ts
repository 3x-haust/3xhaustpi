import { formatHelpCommandLines } from "./tui-command-helpers.ts";
import type { TuiAutocompleteController } from "./tui-live-autocomplete.ts";
import type { TuiDesktopController } from "./tui-live-desktop.ts";
import { startGoalCommand } from "./tui-live-goal.ts";
import { startCompaction, startSideQuestion, startWorkingTreeReview } from "./tui-live-quick-actions.ts";
import { startRewind } from "./tui-live-rewind.ts";
import { startSettings } from "./tui-live-settings.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import { startStatus } from "./tui-live-status.ts";
import type { TuiLiveView } from "./tui-live-view.ts";

export async function handleTuiQuickCommand(
	command: string,
	argument: string,
	deps: {
		readonly core: TuiLiveCore;
		readonly view: TuiLiveView;
		readonly autocomplete: TuiAutocompleteController;
		readonly desktop: TuiDesktopController;
	},
): Promise<boolean> {
	const { core, view, autocomplete, desktop } = deps;
	switch (command) {
		case "help":
			view.appendText(formatHelpCommandLines(process.stdout.columns || 120).join("\n"));
			return true;
		case "btw":
			await startSideQuestion(argument, core, view);
			return true;
		case "goal":
			startGoalCommand(argument, core, view);
			return true;
		case "compact":
			await startCompaction(argument, core, view);
			return true;
		case "review":
			await startWorkingTreeReview(argument, core, view);
			return true;
		case "rewind":
			await startRewind(core, view, autocomplete);
			return true;
		case "settings":
			startSettings(core, view, autocomplete, desktop);
			return true;
		case "status":
			startStatus(core, view);
			return true;
		default:
			return false;
	}
}
