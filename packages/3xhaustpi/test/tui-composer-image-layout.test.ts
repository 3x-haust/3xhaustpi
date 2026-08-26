import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";
const directories: string[] = [];
const cores: TuiLiveCore[] = [];

function pngWithDimensions(width: number, height: number): string {
	const bytes = Buffer.from(ONE_PIXEL_PNG, "base64");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes.toString("base64");
}

function composerFixture(rows = 24): TuiLiveCore {
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-image-layout-"));
	directories.push(directory);
	const core = createTuiLiveCore({
		projectRoot: join(directory, "project"),
		statePath: join(directory, "state.sqlite"),
		runTask: async () => undefined,
		resumeTask: async () => undefined,
	});
	Object.defineProperty(core.ui.terminal, "rows", { configurable: true, value: rows });
	cores.push(core);
	return core;
}

function previewRowBefore(lines: readonly string[], tokenRow: number): number {
	for (let row = tokenRow - 1; row >= 0; row--) {
		const line = lines[row] ?? "";
		if (line.includes("\u001b_G") || stripAnsi(line).includes("▧")) return row;
		if (/^─+$/u.test(stripAnsi(line))) return -1;
	}
	return -1;
}

function kittyColumns(line: string): readonly number[] {
	const columns: number[] = [];
	let cursor = 0;
	let offset = 0;
	while (true) {
		const start = line.indexOf("\u001b_G", offset);
		if (start < 0) return columns;
		cursor += cellWidth(stripAnsi(line.slice(offset, start)));
		columns.push(cursor);
		const end = line.indexOf("\u001b\\", start);
		if (end < 0) return columns;
		offset = end + 2;
	}
}

function firstKittyWidth(line: string): number {
	const match = line.match(/\u001b_G[^;]*\bc=(\d+)/u);
	return Number.parseInt(match?.[1] ?? "0", 10);
}

beforeEach(() => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
});

afterEach(() => {
	for (const core of cores.splice(0)) core.database.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	resetCapabilitiesCache();
});

describe("composer image placement", () => {
	it("renders a metadata-free thumbnail at its matching token column", () => {
		const composer = composerFixture().composer;
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "clipboard.png" });
		composer.editor.setText("Describe [image1]");

		const rendered = composer.render(56);
		const plain = rendered.map(stripAnsi);
		const tokenRow = plain.findIndex((line) => line.includes("[image1]"));
		const previewRow = previewRowBefore(rendered, tokenRow);

		expect(plain[0]).toMatch(/^─+$/u);
		expect(kittyColumns(rendered[previewRow] ?? "")).toContain(plain[tokenRow]?.indexOf("[image1]"));
		expect(plain.join("\n")).not.toMatch(/clipboard\.png|image1 · PNG|click to enlarge/u);
	});

	it("places same-row thumbnails over their respective tokens without collision", () => {
		const composer = composerFixture().composer;
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "first.png" });
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "second.png" });
		composer.editor.setText("[image1]             [image2]");

		const rendered = composer.render(56);
		const plain = rendered.map(stripAnsi);
		const tokenRow = plain.findIndex((line) => line.includes("[image2]"));
		const previewRow = previewRowBefore(rendered, tokenRow);

		expect(kittyColumns(rendered[previewRow] ?? "")).toEqual([
			plain[tokenRow]?.indexOf("[image1]"),
			plain[tokenRow]?.indexOf("[image2]"),
		]);
	});

	it("aligns wrapped tokens and omits previews for scrolled-out tokens", () => {
		const composer = composerFixture().composer;
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "wrapped.png" });
		composer.editor.setText("123456789 [image1]");
		const wrapped = composer.render(14);
		const wrappedPlain = wrapped.map(stripAnsi);
		const tokenRow = wrappedPlain.findIndex((line) => line.includes("[image1]"));
		const previewRow = previewRowBefore(wrapped, tokenRow);
		expect(kittyColumns(wrapped[previewRow] ?? "")).toContain(wrappedPlain[tokenRow]?.indexOf("[image1]"));

		composer.editor.setMaxVisibleLines(1);
		composer.editor.setText("[image1]\nvisible");
		expect(composer.render(20).join("\n")).not.toContain("\u001b_G");
	});

	it("keeps fallback previews metadata-free and within their token slot", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const composer = composerFixture().composer;
		composer.attachImage({
			data: ONE_PIXEL_PNG,
			mimeType: "image/png",
			filename: "clipboard-super-long-name.png",
		});
		composer.editor.setText("x [image1]");

		const rendered = composer.render(20).map(stripAnsi);
		expect(rendered.every((line) => cellWidth(line) <= 20)).toBe(true);
		expect(rendered.join("\n")).not.toMatch(/clipboard|image\/png|PNG|click to enlarge/u);
		const tokenRow = rendered.findIndex((line) => line.includes("[image1]"));
		const fallbackRow = rendered.findIndex((line) => line.trim() === "▧");
		expect(fallbackRow).toBeGreaterThan(0);
		expect(rendered[fallbackRow]?.indexOf("▧")).toBe(rendered[tokenRow]?.indexOf("[image1]"));
	});

	it("limits preview growth to the root layout reservation", () => {
		const rows = 24;
		const composer = composerFixture(rows).composer;
		for (const index of [1, 2, 3]) {
			composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: `${index}.png` });
		}
		composer.editor.setText("[image1]\n[image2]\n[image3]");

		const rendered = composer.render(80);
		expect(rendered.length - 2).toBeLessThanOrEqual(Math.floor(rows * 0.4));
		expect(rendered.join("\n").match(/\u001b_G/gu)).toHaveLength(3);
	});

	it.each([
		{ columns: 32, rows: 10 },
		{ columns: 40, rows: 12 },
	])("reserves one preview row for every visible token at $columns×$rows", ({ columns, rows }) => {
		const composer = composerFixture(rows).composer;
		for (const index of [1, 2, 3]) {
			composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: `${index}.png` });
		}
		composer.editor.setText("[image1]\n[image2]\n[image3]");
		composer.setMaxVisibleLines(6);

		const rendered = composer.render(columns);
		const visibleTokens = rendered.map(stripAnsi).filter((line) => /\[image\d+\]/u.test(line));
		expect(rendered.join("\n").match(/\u001b_G/gu)?.length ?? 0).toBe(visibleTokens.length);
	});

	it("opens the image under the composer cursor from the keyboard", () => {
		const composer = composerFixture().composer;
		const opened: string[] = [];
		composer.onOpenImage = (image) => opened.push(image.token);
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "keyboard.png" });
		composer.editor.handleInput("\u001b[D");

		composer.handleInput("\u000f");

		expect(opened).toEqual(["[image1]"]);
	});

	it("only opens a thumbnail on rows that thumbnail actually renders", () => {
		const core = composerFixture();
		const composer = core.composer;
		const opened: string[] = [];
		composer.onOpenImage = (image) => opened.push(image.token);
		composer.attachImage({ data: pngWithDimensions(100, 1), mimeType: "image/png", filename: "wide.png" });
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "square.png" });
		composer.editor.setText("[image1]                       [image2]");

		const rendered = composer.render(56);
		const plain = rendered.map(stripAnsi);
		const tokenRow = plain.findIndex((line) => line.includes("[image2]"));
		const secondColumn = plain[tokenRow]?.indexOf("[image2]");
		const squareTopRow = rendered.findIndex((line) => kittyColumns(line).includes(secondColumn ?? -1));
		const composerTop = core.ui.terminal.rows - 3 - rendered.length + 1;
		const firstColumn = (plain[tokenRow]?.indexOf("[image1]") ?? 0) + 1;

		expect(composer.handleMouseInput(`\u001b[<0;${firstColumn};${composerTop + squareTopRow}M`)).toBe(false);
		expect(opened).toEqual([]);
	});

	it("does not open a thumbnail from the first blank column beside it", () => {
		const core = composerFixture();
		const composer = core.composer;
		const opened: string[] = [];
		composer.onOpenImage = (image) => opened.push(image.token);
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "square.png" });
		composer.editor.setText("align [image1]");

		const rendered = composer.render(56);
		const plain = rendered.map(stripAnsi);
		const tokenRow = plain.findIndex((line) => line.includes("[image1]"));
		const previewRow = previewRowBefore(rendered, tokenRow);
		const imageWidth = firstKittyWidth(rendered[previewRow] ?? "");
		const composerTop = core.ui.terminal.rows - 3 - rendered.length + 1;
		const firstBlankColumn = (plain[tokenRow]?.indexOf("[image1]") ?? 0) + 1 + imageWidth;

		expect(composer.handleMouseInput(`\u001b[<0;${firstBlankColumn};${composerTop + previewRow}M`)).toBe(false);
		expect(opened).toEqual([]);
	});
});
