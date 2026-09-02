import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_KEYBINDINGS, configureTuiAppKeybindings } from "../src/tui-app-keybindings.ts";
import { TuiAuxiliaryOverlay } from "../src/tui-auxiliary-overlay.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

afterEach(() => {
	APP_KEYBINDINGS.setUserBindings({});
});

function coreFixture() {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-auxiliary-overlay-"));
	const core = createTuiLiveCore({
		projectRoot: join(root, "project"),
		statePath: join(root, "state.sqlite"),
		runTask: async () => undefined,
		resumeTask: async () => undefined,
	});
	return {
		core,
		cleanup: () => {
			core.database.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("auxiliary chat overlay", () => {
	it("accepts a continued chat turn and promotes the latest completed answer", () => {
		const { core, cleanup } = coreFixture();
		const actions = {
			close: vi.fn(),
			invalidate: vi.fn(),
			submit: vi.fn(),
			promote: vi.fn(),
			cancel: vi.fn(),
		};
		const overlay = new TuiAuxiliaryOverlay(core.ui, "side", () => 20, actions);
		overlay.setTranscript([
			{ role: "user", text: "Remember SIDE_842" },
			{ role: "assistant", text: "Remembered SIDE_842", sourceId: "side_turn_1" },
		]);
		overlay.setState("ready");

		overlay.handleInput("continue this chat");
		overlay.handleInput("\r");
		overlay.handleInput("\u0012");
		overlay.render(80);
		overlay.handleInput("\r");

		expect(actions.submit).toHaveBeenCalledWith("continue this chat");
		expect(actions.promote).toHaveBeenCalledOnce();
		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("Side Chat · isolated");
		cleanup();
	});

	it("labels BTW as main-aware and cancels a running request on Escape", () => {
		const { core, cleanup } = coreFixture();
		const actions = {
			close: vi.fn(),
			invalidate: vi.fn(),
			submit: vi.fn(),
			promote: vi.fn(),
			cancel: vi.fn(),
		};
		const overlay = new TuiAuxiliaryOverlay(core.ui, "btw", () => 20, actions);
		overlay.setState("running");

		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("BTW · main-aware");
		overlay.handleInput("\u001b");

		expect(actions.cancel).toHaveBeenCalledOnce();
		expect(actions.close).toHaveBeenCalledOnce();
		cleanup();
	});

	it("keeps compact rendering within cell width and prevents repeat promotion", () => {
		const { core, cleanup } = coreFixture();
		const actions = {
			close: vi.fn(),
			invalidate: vi.fn(),
			submit: vi.fn(),
			promote: vi.fn(),
			cancel: vi.fn(),
		};
		const overlay = new TuiAuxiliaryOverlay(core.ui, "side", () => 8, actions);
		overlay.setTranscript([{ role: "assistant", text: "한글 응답 with a long answer", sourceId: "side_turn_1" }]);
		overlay.markPromoted("side_turn_1");
		overlay.handleInput("\u0012");
		overlay.handleInput("\r");

		const rendered = overlay.render(20);
		expect(rendered.every((line) => cellWidth(stripAnsi(line)) <= 20)).toBe(true);
		expect(rendered.length).toBeGreaterThanOrEqual(4);
		expect(rendered.length).toBeLessThanOrEqual(8);
		expect(actions.promote).not.toHaveBeenCalled();
		cleanup();
	});

	it("strips provider-controlled terminal sequences from failure messages", () => {
		const { core, cleanup } = coreFixture();
		const overlay = new TuiAuxiliaryOverlay(core.ui, "side", () => 20, {
			close: vi.fn(),
			invalidate: vi.fn(),
			submit: vi.fn(),
			promote: vi.fn(),
			cancel: vi.fn(),
		});

		overlay.setState("failure", "\u001b]52;c;ZXhmaWx0cmF0ZQ==\u0007provider failed\nfor account");
		const rendered = overlay.render(80).join("\n");

		expect(rendered).not.toContain("\u001b]52");
		expect(stripAnsi(rendered)).toContain("provider failed for account");
		cleanup();
	});

	it("shows the full promoted answer from its start and requires review to the end", () => {
		const { core, cleanup } = coreFixture();
		const actions = {
			close: vi.fn(),
			invalidate: vi.fn(),
			submit: vi.fn(),
			promote: vi.fn(),
			cancel: vi.fn(),
		};
		const overlay = new TuiAuxiliaryOverlay(core.ui, "side", () => 12, actions);
		overlay.setTranscript([
			{ role: "user", text: "Review this answer" },
			{
				role: "assistant",
				sourceId: "side_long",
				text: `UNTRUSTED_START\n${Array.from({ length: 24 }, (_, index) => `line ${index}`).join("\n")}\nBENIGN_END`,
			},
		]);

		overlay.handleInput("\u0012");
		const firstReview = stripAnsi(overlay.render(72).join("\n"));
		overlay.handleInput("\r");

		expect(firstReview).toContain("UNTRUSTED_START");
		expect(firstReview).not.toContain("BENIGN_END");
		expect(actions.promote).not.toHaveBeenCalled();

		overlay.handleInput("\u001b[F");
		expect(stripAnsi(overlay.render(72).join("\n"))).toContain("BENIGN_END");
		overlay.handleInput("\r");
		expect(actions.promote).toHaveBeenCalledOnce();
		cleanup();
	});

	it("uses remapped promotion and confirmation keys in behavior and hints", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "3xhaustpi-keybindings-"));
		const configPath = join(configRoot, "keybindings.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				"app.auxiliary.promote": "ctrl+p",
				"tui.select.confirm": "ctrl+y",
			}),
		);
		configureTuiAppKeybindings(configPath);
		const { core, cleanup } = coreFixture();
		const actions = {
			close: vi.fn(),
			invalidate: vi.fn(),
			submit: vi.fn(),
			promote: vi.fn(),
			cancel: vi.fn(),
		};
		const overlay = new TuiAuxiliaryOverlay(core.ui, "side", () => 20, actions);
		overlay.setTranscript([
			{ role: "user", text: "Question" },
			{ role: "assistant", sourceId: "side_remap", text: "review me" },
		]);

		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("Ctrl+P promote");
		overlay.handleInput("\u0012");
		expect(stripAnsi(overlay.render(80).join("\n"))).not.toContain("Review answer before promotion");
		overlay.handleInput("\u0010");
		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("Ctrl+Y promote");
		overlay.handleInput("\r");
		expect(actions.promote).not.toHaveBeenCalled();
		overlay.handleInput("\u0019");
		expect(actions.promote).toHaveBeenCalledOnce();
		cleanup();
		rmSync(configRoot, { recursive: true, force: true });
	});

	it("rejects forged prototype receivers before authorization state is read", () => {
		const forged = Object.create(TuiAuxiliaryOverlay.prototype) as TuiAuxiliaryOverlay;

		expect(() => Reflect.apply(TuiAuxiliaryOverlay.prototype.handleInput, forged, ["\r"])).toThrow(TypeError);
	});
});
