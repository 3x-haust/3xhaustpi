import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiLiveCore } from "../src/tui-live-state.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native TUI composer", () => {
	it("grows for multiline input and remains bounded", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-composer-"));
		directories.push(root);
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		core.editor.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));

		const lines = core.editor.render(56);
		expect(lines.length).toBeGreaterThan(3);
		expect(lines.length).toBeLessThanOrEqual(7);
		expect(lines.join("\n")).toContain("line 10");
		core.database.close();
	});
});
