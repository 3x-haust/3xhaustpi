import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ThreeXhaustState } from "../src/state.ts";
import { startGoalCommand } from "../src/tui-live-goal.ts";
import { createTuiLiveCore, liveContextLimit } from "../src/tui-live-state.ts";
import { buildTuiStatusSnapshot } from "../src/tui-live-status.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { stripAnsi } from "../src/tui-text.ts";

describe("/goal", () => {
	it("persists one project-scoped goal lifecycle across state reopen", () => {
		// Given: a project with no stored goal.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-goal-state-"));
		const projectRoot = join(root, "project");
		const statePath = join(root, "state.sqlite");
		const first = new ThreeXhaustState(statePath);

		// When: the goal is set, reopened, completed, and cleared.
		first.setTuiProjectGoal(projectRoot, "Ship context telemetry", "2026-08-26T00:00:00.000Z");
		first.close();
		const reopened = new ThreeXhaustState(statePath);
		const active = reopened.findTuiProjectGoal(projectRoot);
		const completed = reopened.completeTuiProjectGoal(projectRoot, "2026-08-26T00:00:01.000Z");
		reopened.clearTuiProjectGoal(projectRoot);

		// Then: each transition is durable and scoped to that project.
		expect(active).toEqual({
			projectPath: projectRoot,
			text: "Ship context telemetry",
			status: "active",
			updatedAt: "2026-08-26T00:00:00.000Z",
		});
		expect(completed).toMatchObject({ text: "Ship context telemetry", status: "completed" });
		expect(reopened.findTuiProjectGoal(projectRoot)).toBeUndefined();
		expect(reopened.findTuiProjectGoal(join(root, "other"))).toBeUndefined();
		reopened.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("sets shows completes and clears the active footer goal", () => {
		// Given: an idle TUI with no current project goal.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-goal-command-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);

		// When: the canonical goal commands run through their lifecycle.
		startGoalCommand("Ship durable 목표", core, view);
		const activeBrand = stripAnsi(core.brand.render(80).join("\n"));
		const activeStatus = buildTuiStatusSnapshot(core, view);
		startGoalCommand("", core, view);
		startGoalCommand("done", core, view);
		const completedBrand = stripAnsi(core.brand.render(80).join("\n"));
		startGoalCommand("clear", core, view);

		// Then: active intent is visible, completion hides it, and clear removes storage.
		expect(activeBrand).toContain("Goal Ship durable 목표");
		expect(activeStatus.goal).toBe("Ship durable 목표");
		expect(stripAnsi(core.transcriptEntries.join("\n"))).toContain("Goal · active · Ship durable 목표");
		expect(core.transcriptEntries.join("\n")).toContain("Goal completed");
		expect(completedBrand).not.toContain("Goal ");
		expect(core.database.findTuiProjectGoal(core.state.projectRoot)).toBeUndefined();
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves the selected model context window without an injected limit", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-context-limit-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});

		const view = createTuiLiveView(core);
		core.state.latestContextTokens = 11_000;
		view.updateHeader();

		expect(liveContextLimit(core)).toBe(272_000);
		expect(stripAnsi(core.brand.render(120).join("\n"))).toContain("Ctx 11K/272K · 4.0%");
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("scopes an injected context limit to the initial model selection", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-context-override-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			contextLimit: 400_000,
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});

		expect(liveContextLimit(core)).toBe(400_000);
		core.state.model = "gpt-5.3-codex-spark";
		expect(liveContextLimit(core)).toBe(128_000);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("enforces one-line bounded goal text at the storage boundary", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-goal-boundary-"));
		const statePath = join(root, "state.sqlite");
		const projectRoot = join(root, "project");
		const state = new ThreeXhaustState(statePath);

		expect(() => state.setTuiProjectGoal(projectRoot, "a".repeat(501))).toThrow(/500 characters/u);
		expect(state.setTuiProjectGoal(projectRoot, "  출시\n목표\t\u001b[31m안전\u001b[0m  ").text).toBe(
			"출시 목표 안전",
		);
		state.close();

		const raw = new DatabaseSync(statePath);
		expect(() =>
			raw
				.prepare(
					`UPDATE tui_project_goal SET goal_text = ?
					 WHERE canonical_path = ?`,
				)
				.run("b".repeat(10_000), projectRoot),
		).toThrow(/invalid project goal text/u);
		expect(() =>
			raw
				.prepare(
					`UPDATE tui_project_goal SET goal_text = ?
					 WHERE canonical_path = ?`,
				)
				.run(`a\u0000${"x".repeat(10_000)}`, projectRoot),
		).toThrow(/invalid project goal text/u);
		raw.exec("DROP TRIGGER tui_project_goal_text_update");
		raw.exec("PRAGMA ignore_check_constraints = ON");
		raw.prepare(
			`UPDATE tui_project_goal SET goal_text = ?
				 WHERE canonical_path = ?`,
		).run(`a\u0000${"x".repeat(10_000)}`, projectRoot);
		raw.close();
		const reopened = new ThreeXhaustState(statePath);
		expect(reopened.findTuiProjectGoal(projectRoot)).toBeUndefined();
		reopened.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects oversized raw goal input before persistence", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-goal-raw-limit-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);

		startGoalCommand("a".repeat(10_000), core, view);
		startGoalCommand("a".repeat(501), core, view);

		expect(core.transcriptEntries.join("\n")).toContain("Goal must be 500 characters or fewer.");
		expect(core.database.findTuiProjectGoal(core.state.projectRoot)).toBeUndefined();
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("returns the exact goal row completed by its atomic update", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-goal-complete-race-"));
		const statePath = join(root, "state.sqlite");
		const projectRoot = join(root, "project");
		const state = new ThreeXhaustState(statePath);
		state.setTuiProjectGoal(projectRoot, "Original goal", "2026-08-26T00:00:00.000Z");
		const raw = new DatabaseSync(statePath);
		raw.exec(`
			CREATE TRIGGER replace_completed_goal AFTER UPDATE OF status ON tui_project_goal
			WHEN NEW.status = 'completed'
			BEGIN
				UPDATE tui_project_goal
				SET goal_text = 'Replacement goal', status = 'active'
				WHERE canonical_path = NEW.canonical_path;
			END
		`);
		raw.close();

		const completed = state.completeTuiProjectGoal(projectRoot, "2026-08-26T00:00:01.000Z");

		expect(completed).toMatchObject({ text: "Original goal", status: "completed" });
		expect(state.findTuiProjectGoal(projectRoot)).toMatchObject({ text: "Replacement goal", status: "active" });
		state.close();
		rmSync(root, { recursive: true, force: true });
	});
});
