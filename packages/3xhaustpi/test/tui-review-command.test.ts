import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWorkingTreeReview } from "../src/tui-live-quick-actions.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

describe("/review", () => {
	it("runs a read-only working-tree review outside the conversation queue", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-review-"));
		try {
			let focus: string | undefined;
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => {
					throw new Error("Review must not enter the normal task queue");
				},
				resumeTask: async () => undefined,
				reviewWorkingTree: async (request) => {
					focus = request.focus;
					return "No blocking findings.";
				},
			});
			const view = createTuiLiveView(core);
			const before = core.database.readTuiConversationHead(core.state.projectRoot);

			await startWorkingTreeReview("focus on regressions", core, view);

			expect(focus).toBe("focus on regressions");
			expect(core.database.readTuiConversationHead(core.state.projectRoot)).toEqual(before);
			expect(core.state.queuedRequests).toHaveLength(0);
			expect(core.ui.hasOverlay()).toBe(true);
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
