import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSideQuestion } from "../src/tui-live-quick-actions.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

describe("/btw", () => {
	it("runs outside the durable conversation with bounded context", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-btw-"));
		try {
			let received:
				| {
						readonly question: string;
						readonly context: string;
						readonly provider: string;
						readonly model: string;
				  }
				| undefined;
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				runSideQuestion: async (request) => {
					received = request;
					return "Temporary answer";
				},
			});
			const view = createTuiLiveView(core);
			view.appendText("Main conversation context");
			const before = [...core.transcriptEntries];

			await startSideQuestion("Why is this named that way?", core, view);

			expect(received).toMatchObject({
				question: "Why is this named that way?",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
			});
			expect(received?.context).toContain("Main conversation context");
			expect(core.transcriptEntries).toEqual(before);
			expect(core.ui.hasOverlay()).toBe(true);
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
