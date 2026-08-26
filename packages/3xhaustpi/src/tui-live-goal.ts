import {
	MAX_PROJECT_GOAL_CHARACTERS,
	MAX_PROJECT_GOAL_RAW_CODE_UNITS,
	normalizeProjectGoalText,
} from "./project-goal-text.ts";
import type { TuiLiveCore } from "./tui-live-state.ts";
import type { TuiLiveView } from "./tui-live-view.ts";
import { success, text, warning } from "./tui-text.ts";

export function startGoalCommand(argument: string, core: TuiLiveCore, view: TuiLiveView): void {
	if (argument.length > MAX_PROJECT_GOAL_RAW_CODE_UNITS) {
		view.appendText(warning(`Goal must be ${MAX_PROJECT_GOAL_CHARACTERS} characters or fewer.`));
		return;
	}
	let command: string;
	try {
		command = normalizeProjectGoalText(argument);
	} catch {
		view.appendText(warning(`Goal must be ${MAX_PROJECT_GOAL_CHARACTERS} characters or fewer.`));
		return;
	}
	if (!command) {
		const goal = core.database.findTuiProjectGoal(core.state.projectRoot);
		core.state.projectGoal = goal;
		view.appendText(
			goal ? `${text("Goal")} · ${goal.status} · ${text(goal.text)}` : warning("No project goal is set."),
		);
		view.updateHeader();
		return;
	}
	if (command.toLowerCase() === "clear") {
		core.database.clearTuiProjectGoal(core.state.projectRoot);
		core.state.projectGoal = undefined;
		view.updateHeader();
		view.appendText(success("Goal cleared."));
		return;
	}
	if (command.toLowerCase() === "done") {
		const completed = core.database.completeTuiProjectGoal(core.state.projectRoot);
		if (!completed) {
			view.appendText(warning("No active project goal to complete."));
			return;
		}
		core.state.projectGoal = completed;
		view.updateHeader();
		view.appendText(success(`Goal completed · ${completed.text}`));
		return;
	}
	const goal = core.database.setTuiProjectGoal(core.state.projectRoot, command);
	core.state.projectGoal = goal;
	view.updateHeader();
	view.appendText(success(`Goal set · ${goal.text}`));
}
