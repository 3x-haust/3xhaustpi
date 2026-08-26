import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { stripAnsi } from "../src/tui-text.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";
const directories: string[] = [];
const cores: TuiLiveCore[] = [];

function composerFixture(): TuiLiveCore {
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-image-interaction-"));
	directories.push(directory);
	const core = createTuiLiveCore({
		projectRoot: join(directory, "project"),
		statePath: join(directory, "state.sqlite"),
		runTask: async () => undefined,
		resumeTask: async () => undefined,
	});
	Object.defineProperty(core.ui.terminal, "rows", { configurable: true, value: 24 });
	cores.push(core);
	return core;
}

beforeEach(() => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
});

afterEach(() => {
	for (const core of cores.splice(0)) core.database.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	resetCapabilitiesCache();
});

describe("composer image interactions", () => {
	it("renders every visible occurrence of the same image token", () => {
		const composer = composerFixture().composer;
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "repeat.png" });
		composer.editor.setText("[image1]\n[image1]");

		const rendered = composer.render(56).join("\n");

		expect(rendered.match(/\u001b_G/gu)).toHaveLength(2);
		expect(new Set([...rendered.matchAll(/\bi=(\d+)/gu)].map((match) => match[1])).size).toBe(2);
	});

	it("opens the adjacent token that visually contains the keyboard cursor", () => {
		const composer = composerFixture().composer;
		const opened: string[] = [];
		composer.onOpenImage = (image) => opened.push(image.token);
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "first.png" });
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "second.png" });
		composer.editor.setText("[image1][image2]");
		for (let step = 0; step < "[image2]".length; step++) composer.editor.handleInput("\u001b[D");

		composer.handleInput("\u000f");

		expect(opened).toEqual(["[image2]"]);
	});

	it("opens a repeated token from its second same-row occurrence", () => {
		const composer = composerFixture().composer;
		const opened: string[] = [];
		composer.onOpenImage = (image) => opened.push(image.token);
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "repeat.png" });
		composer.editor.setText("[image1][image1]");
		for (let step = 0; step < "[image1]".length; step++) composer.editor.handleInput("\u001b[D");

		composer.handleInput("\u000f");

		expect(opened).toEqual(["[image1]"]);
	});

	it("excludes the first blank iTerm column from the thumbnail hit box", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const core = composerFixture();
		const composer = core.composer;
		const opened: string[] = [];
		composer.onOpenImage = (image) => opened.push(image.token);
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "iterm.png" });
		composer.editor.setText("align [image1]");

		const rendered = composer.render(56);
		const plain = rendered.map(stripAnsi);
		const tokenRow = plain.findIndex((line) => line.includes("[image1]"));
		const previewRow = rendered.findIndex((line) => line.includes("\u001b]1337;File="));
		const imageWidth = Number.parseInt(rendered[previewRow]?.match(/(?:^|;)width=(\d+)(?:;|:)/u)?.[1] ?? "0", 10);
		const composerTop = core.ui.terminal.rows - 3 - rendered.length + 1;
		const firstBlankColumn = (plain[tokenRow]?.indexOf("[image1]") ?? 0) + 1 + imageWidth;

		expect(composer.handleMouseInput(`\u001b[<0;${firstBlankColumn};${composerTop + previewRow}M`)).toBe(false);
		expect(opened).toEqual([]);
	});
});
