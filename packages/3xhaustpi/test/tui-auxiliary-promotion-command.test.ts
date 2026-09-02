import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAccount } from "../src/account-selection.ts";
import type { ProviderConnection } from "../src/connections.ts";
import { TuiAuxiliaryOverlay } from "../src/tui-auxiliary-overlay.ts";
import { promoteTuiAuxiliaryInView } from "../src/tui-auxiliary-promotion.ts";
import { createTuiAuxiliaryController } from "../src/tui-live-auxiliary.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { stripAnsi } from "../src/tui-text.ts";

const connectionFixture = vi.hoisted((): { providers: ProviderConnection[] } => ({ providers: [] }));

vi.mock("../src/connections.ts", () => ({
	collectProviderConnections: () => Promise.resolve(connectionFixture.providers),
}));

const cleanups: Array<() => void> = [];

beforeEach(() => {
	const account: ModelAccount = {
		id: "openai-codex:alpha",
		providerId: "openai-codex",
		label: "alpha",
		detail: "test",
		active: true,
	};
	connectionFixture.providers = [
		{
			id: "openai-codex",
			name: "OpenAI Codex",
			modelCount: 1,
			modelIds: ["gpt-5.6-terra"],
			authMethods: [],
			configured: true,
			accounts: [account],
		},
	];
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function captureAuxiliaryOverlay(core: ReturnType<typeof createTuiLiveCore>) {
	let captured: TuiAuxiliaryOverlay | undefined;
	const showOverlay = core.ui.showOverlay.bind(core.ui);
	core.ui.showOverlay = ((component, options) => {
		if (component instanceof TuiAuxiliaryOverlay) captured = component;
		return showOverlay(component, options);
	}) as typeof core.ui.showOverlay;
	return () => {
		if (!captured) throw new Error("Expected auxiliary overlay");
		return captured;
	};
}

async function promoteThroughKeys(
	overlay: TuiAuxiliaryOverlay,
	view: ReturnType<typeof createTuiLiveView>,
	expectedReceipt: string,
): Promise<void> {
	const receipt = deferred();
	const appendText = view.appendText.bind(view);
	view.appendText = (value) => {
		appendText(value);
		if (stripAnsi(value).includes(expectedReceipt)) receipt.resolve();
	};
	overlay.handleInput("\u0012");
	overlay.render(80);
	overlay.handleInput("\r");
	await receipt.promise;
}

describe("auxiliary promotion", () => {
	it("rejects direct admission without one-time overlay review authorization", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-promotion-authorization-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);
		const overlay = new TuiAuxiliaryOverlay(core.ui, "side", () => 20, {
			close() {},
			invalidate() {},
			submit() {},
			promote() {},
			cancel() {},
		});
		overlay.setTranscript([
			{ role: "user", text: "Question" },
			{ role: "assistant", sourceId: "side_direct", text: "Answer" },
		]);

		expect(
			await promoteTuiAuxiliaryInView(
				core,
				view,
				overlay,
				[
					{
						kind: "side",
						sourceId: "side_direct",
						question: "Question",
						answer: "Answer",
						completedAt: "2026-09-03T00:00:00.000Z",
					},
				],
				undefined,
			),
		).toBe("unavailable");
		expect(core.database.listTuiRequests(core.state.projectRoot)).toEqual([]);
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("never promotes an answer from a different auxiliary surface", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-promotion-kind-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
			runAuxiliary: async () => "BTW_ONLY_ANSWER",
		});
		const view = createTuiLiveView(core);
		const currentOverlay = captureAuxiliaryOverlay(core);
		const auxiliary = createTuiAuxiliaryController(core, view);

		await auxiliary.startBtw("BTW only");
		await auxiliary.startSide("");

		expect(currentOverlay().latestPromotable()).toBeUndefined();
		currentOverlay().handleInput("\u0012");
		currentOverlay().handleInput("\r");
		expect(core.database.listTuiRequests(core.state.projectRoot)).toEqual([]);
		await auxiliary.shutdown();
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("admits Side and BTW answers durably in FIFO order and deduplicates repeated promotion", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-promotion-command-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
			runAuxiliary: async ({ kind }) => `${kind.toUpperCase()}_ANSWER`,
		});
		const view = createTuiLiveView(core);
		const currentOverlay = captureAuxiliaryOverlay(core);
		const drainQueue = vi.fn();
		const auxiliary = createTuiAuxiliaryController(core, view, { drainQueue });
		cleanups.push(() => {
			void auxiliary.shutdown();
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
			rmSync(root, { recursive: true, force: true });
		});

		await auxiliary.startSide("Side question");
		await promoteThroughKeys(currentOverlay(), view, "Promoted to main queue at position 1");
		await auxiliary.startSide("");
		await promoteThroughKeys(currentOverlay(), view, "already in the main queue");
		await auxiliary.startBtw("BTW question");
		await promoteThroughKeys(currentOverlay(), view, "Promoted to main queue at position 2");

		expect(core.database.listTuiRequests(core.state.projectRoot)).toEqual([
			expect.objectContaining({
				position: 1,
				objective: expect.stringContaining("SIDE_ANSWER"),
				promotion: {
					version: 1,
					source: expect.objectContaining({ kind: "side", question: "Side question", answer: "SIDE_ANSWER" }),
				},
			}),
			expect.objectContaining({
				position: 2,
				objective: expect.stringContaining("BTW_ANSWER"),
				promotion: {
					version: 1,
					source: expect.objectContaining({ kind: "btw", question: "BTW question", answer: "BTW_ANSWER" }),
				},
			}),
		]);
		expect(drainQueue).toHaveBeenCalledTimes(2);
		const visible = core.transcriptEntries.map(stripAnsi).join("\n");
		expect(visible).toContain("Promoted to main queue at position 1");
		expect(visible).toContain("already in the main queue");
		await auxiliary.shutdown();
	});
});
