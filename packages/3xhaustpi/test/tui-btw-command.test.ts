import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "../src/connections.ts";
import type { TuiAuxiliaryRequest } from "../src/tui-contract.ts";
import { createTuiAuxiliaryController } from "../src/tui-live-auxiliary.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

describe("/btw", () => {
	it("keeps process-local follow-up history and refreshes its immutable main observation", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-btw-"));
		try {
			const requests: TuiAuxiliaryRequest[] = [];
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				runAuxiliary: async (request) => {
					requests.push(request);
					return requests.length === 1 ? "First BTW answer" : "Second BTW answer";
				},
			});
			const view = createTuiLiveView(core);
			view.appendText("MAIN_FACT_219");
			core.state.phase = "running";
			core.state.activeCapabilities = ["read"];
			core.state.activeWork.set("work_1", { kind: "tool", label: "Inspect current work" });
			const before = [...core.transcriptEntries];
			const connections: readonly ProviderConnection[] = [
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					modelCount: 1,
					modelIds: ["gpt-5.6-terra"],
					authMethods: [],
					configured: true,
					accounts: [
						{
							id: "openai-codex:alpha",
							providerId: "openai-codex",
							label: "alpha",
							detail: "test",
							active: true,
						},
					],
				},
			];
			const auxiliary = createTuiAuxiliaryController(core, view, {
				collectConnections: () => Promise.resolve(connections),
			});

			await auxiliary.startBtw("What is main doing?");
			core.state.activeWork.set("work_2", { kind: "tool", label: "Implement current work" });
			await auxiliary.startBtw("And now?");
			expect(core.transcriptEntries).toEqual(before);
			const firstIdentity = requests[0]?.identity;
			core.state.projectRoot = join(root, "other-project");
			view.replaceConversation([]);
			await auxiliary.startBtw("What is this project doing?");

			expect(requests[0]).toMatchObject({
				kind: "btw",
				question: "What is main doing?",
				history: [],
				observation: {
					phase: "running",
					activeCapabilities: ["read"],
					activeWork: ["Inspect current work"],
					transcriptTail: expect.stringContaining("MAIN_FACT_219"),
				},
			});
			expect(requests[1]).toMatchObject({
				kind: "btw",
				question: "And now?",
				history: [{ question: "What is main doing?", answer: "First BTW answer" }],
				observation: {
					activeWork: ["Inspect current work", "Implement current work"],
				},
			});
			expect(requests[2]).toMatchObject({
				kind: "btw",
				question: "What is this project doing?",
				history: [],
			});
			expect(requests[2]?.identity).not.toBe(firstIdentity);
			expect(core.transcriptEntries).toEqual([]);
			expect(core.ui.hasOverlay()).toBe(true);
			await auxiliary.shutdown();
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
