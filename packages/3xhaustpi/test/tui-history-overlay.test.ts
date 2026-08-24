import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TuiHistoryOverlay } from "../src/tui-history-overlay.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

describe("TUI history overlay", () => {
	it("owns paging and closes without mutating transcript", () => {
		const entries = Array.from({ length: 20 }, (_, index) => `You message ${index + 1}`);
		let closed = false;
		const overlay = new TuiHistoryOverlay(entries, () => 10, {
			close: () => {
				closed = true;
			},
			invalidate: () => {},
		});

		expect(overlay.render(40).join("\n")).toContain("message 20");
		overlay.handleInput("\u001b[5~");
		expect(overlay.render(40).join("\n")).not.toContain("message 20");
		overlay.handleInput("q");
		expect(closed).toBe(true);
		expect(entries).toHaveLength(20);
	});

	it("does not overscroll past history that already fits", () => {
		const overlay = new TuiHistoryOverlay(["Only visible entry"], () => 24, {
			close: () => {},
			invalidate: () => {},
		});

		expect(overlay.render(80).join("\n")).toContain("Only visible entry");
		overlay.handleInput("\u001b[5~");

		const rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("Only visible entry");
		expect(rendered).toContain("live tail");
	});

	it("retains the complete live transcript for the history surface", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-history-complete-"));
		try {
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
			});
			const view = createTuiLiveView(core);

			for (let index = 1; index <= 200; index += 1) view.appendText(`entry ${index}`);

			expect(core.transcriptEntries).toHaveLength(200);
			expect(core.transcriptEntries[0]).toContain("entry 1");
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
