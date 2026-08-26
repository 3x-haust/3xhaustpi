import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreeXhaustState } from "../src/state.ts";
import { expandedImagePreviewRows } from "../src/tui-image-viewer.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";
import { formatSubmittedPromptTurn } from "../src/tui-transcript.ts";

const imageMocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn(),
	resizeImage: vi.fn(),
}));

vi.mock("../../coding-agent/src/utils/clipboard-image.ts", () => ({
	readClipboardImage: imageMocks.readClipboardImage,
}));

vi.mock("../../coding-agent/src/utils/image-resize.ts", () => ({
	resizeImage: imageMocks.resizeImage,
}));

const directories: string[] = [];
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";

beforeEach(() => {
	imageMocks.readClipboardImage.mockReset();
	imageMocks.resizeImage.mockReset();
});

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pasted image composer preview", () => {
	function composerFixture() {
		const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-image-composer-"));
		directories.push(directory);
		const core = createTuiLiveCore({
			projectRoot: join(directory, "project"),
			statePath: join(directory, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		return core;
	}

	it("reserves overlay title and footer rows from the enlarged image height", () => {
		expect(expandedImagePreviewRows(22)).toBe(17);
		expect(expandedImagePreviewRows(30)).toBe(25);
	});

	it("keeps transcript click affordances visible without composer metadata", () => {
		const core = composerFixture();
		const filename = "剪贴板画像_日本語_한글_非常に長い名前.png";
		core.composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename });
		const composerRows = stripAnsi(core.composer.render(56).join("\n"));
		expect(composerRows).not.toContain("click to enlarge");
		expect(composerRows).not.toContain("image1 · PNG");

		const view = createTuiLiveView(core);
		view.appendUser("Describe [image1]", true, [
			{ data: ONE_PIXEL_PNG, mimeType: "image/png", token: "[image1]", filename },
		]);
		const transcript = stripAnsi(core.transcript.render(56).join("\n"));
		const transcriptLabel = transcript.split("\n").find((line) => line.includes("[image1] · PNG")) ?? "";
		expect(transcriptLabel).toContain("click to enlarge");
		expect(cellWidth(transcriptLabel)).toBeLessThanOrEqual(56);

		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("uses the external coding-agent resizer for large clipboard images", async () => {
		const clipboardBytes = new Uint8Array(2_000_000);
		imageMocks.readClipboardImage.mockResolvedValue({ bytes: clipboardBytes, mimeType: "image/png" });
		imageMocks.resizeImage.mockResolvedValue({
			data: ONE_PIXEL_PNG,
			mimeType: "image/png",
			originalWidth: 3024,
			originalHeight: 1964,
			width: 2000,
			height: 1299,
			wasResized: true,
		});
		const core = composerFixture();
		let finish: ((outcome: "render" | "error") => void) | undefined;
		const outcome = new Promise<"render" | "error">((resolve) => {
			finish = resolve;
		});
		core.composer.onRenderRequested = () => finish?.("render");
		core.composer.onError = () => finish?.("error");

		core.composer.handleInput("\u0016");

		expect(await outcome).toBe("render");
		expect(imageMocks.resizeImage).toHaveBeenCalledWith(clipboardBytes, "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 4.5 * 1024 * 1024,
		});
		expect(core.composer.editor.getText()).toBe("[image1]");
		core.database.close();
	}, 15_000);

	it("only submits images whose placeholder still exists and clears previews after submission", () => {
		const core = composerFixture();
		const composer = core.composer;
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "first.png" });
		composer.attachImage({ data: ONE_PIXEL_PNG, mimeType: "image/png", filename: "second.png" });
		composer.editor.setText("Compare [image2]");

		expect(composer.imagesFor("Compare [image2]")).toEqual([{ data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
		expect(stripAnsi(composer.render(56).join("\n"))).not.toContain("image1 · PNG");

		composer.clearAttachments();
		expect(stripAnsi(composer.render(56).join("\n"))).not.toContain("image2 · PNG");
		core.database.close();
	});

	it("keeps submitted images visible and clickable in the user chat card", () => {
		const core = composerFixture();
		const view = createTuiLiveView(core);
		const opened: string[] = [];
		core.transcript.onOpenImage = (image) => opened.push(image.token);
		view.appendUser("Describe [image1]", true, [
			{
				data: ONE_PIXEL_PNG,
				mimeType: "image/png",
				token: "[image1]",
				filename: "clipboard.png",
			},
		]);

		const rendered = stripAnsi(core.transcript.render(56).join("\n"));
		expect(rendered).toContain("[image1] · PNG · clipboard.png");
		const imageRow = rendered.split("\n").findIndex((line) => line.includes("[image1] · PNG")) + 1;
		expect(core.transcript.handleMouseInput(`\u001b[<0;2;${imageRow}M`)).toBe(true);
		expect(opened).toEqual(["[image1]"]);

		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
	});

	it("keeps image placeholders in the visible user transcript", () => {
		expect(formatSubmittedPromptTurn("Compare [image1] and [image2]", true)).toBe(
			"You Compare [image1] and [image2]",
		);
	});

	it("persists image payloads through the durable TUI queue", () => {
		const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-image-queue-"));
		directories.push(directory);
		const state = new ThreeXhaustState(join(directory, "state.sqlite"));
		const projectPath = join(directory, "project");
		const enqueued = state.enqueueTuiRequest({
			requestId: "request-image",
			projectPath,
			fingerprint: "fingerprint-image",
			objective: "Describe [image1]",
			images: [{ data: ONE_PIXEL_PNG, mimeType: "image/png" }],
		});

		expect(enqueued.request.images).toEqual([{ data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
		const claim = state.claimNextTuiRequest(projectPath, { ownerId: "image-worker" });
		expect(claim?.images).toEqual([{ data: ONE_PIXEL_PNG, mimeType: "image/png" }]);
		state.close();
	});

	it("rejects malformed or MIME-spoofed images before queue persistence", () => {
		const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-image-invalid-"));
		directories.push(directory);
		const state = new ThreeXhaustState(join(directory, "state.sqlite"));
		const projectPath = join(directory, "project");
		const enqueue = (data: string) =>
			state.enqueueTuiRequest({
				requestId: `request-${data.length}`,
				projectPath,
				fingerprint: `fingerprint-${data.length}`,
				objective: "Describe [image1]",
				images: [{ data, mimeType: "image/png" }],
			});

		expect(() => enqueue("not base64!")).toThrow(/base64/u);
		expect(() => enqueue(Buffer.from("not a png").toString("base64"))).toThrow(/signature/u);
		state.close();
	});
});
