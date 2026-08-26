import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiLiveCore } from "../src/tui-live-state.ts";

const directories: string[] = [];
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";
const SECOND_PIXEL_PNG = `${ONE_PIXEL_PNG.slice(0, -1)}A`;

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

	it("restores recalled image tokens without renumbering the draft", () => {
		// Given: a queued draft whose two original attachment tokens were reordered.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-composer-"));
		directories.push(root);
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		core.composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png" });
		core.composer.attachImage({ data: SECOND_PIXEL_PNG, mimeType: "image/png" });
		const text = "inspect [image2] before [image1]";
		core.editor.setText(text);
		const persisted = core.composer.imagesFor(text);
		core.composer.clearAttachments();

		// When: the reordered pending draft and persisted payloads are restored.
		core.composer.restoreDraft(text, persisted);

		// Then: each original token retains its payload and numbering.
		expect(core.editor.getText()).toBe(text);
		expect(core.composer.displayImagesFor(core.editor.getText())).toEqual([
			{
				data: ONE_PIXEL_PNG,
				mimeType: "image/png",
				token: "[image1]",
				filename: "image1",
			},
			{
				data: SECOND_PIXEL_PNG,
				mimeType: "image/png",
				token: "[image2]",
				filename: "image2",
			},
		]);
		core.composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png" });
		expect(core.editor.getText()).toContain("[image3]");
		core.database.close();
	});
});
