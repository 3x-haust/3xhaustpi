import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "../src/connections.ts";
import type { TuiAuxiliaryRequest } from "../src/tui-contract.ts";
import { createTuiAuxiliaryController } from "../src/tui-live-auxiliary.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("/side", () => {
	it("runs one pending follow-up after the active turn and rejects another", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-side-pending-"));
		try {
			const started = deferred();
			const release = deferred();
			const questions: string[] = [];
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				runAuxiliary: async (request) => {
					questions.push(request.question);
					if (questions.length === 1) {
						started.resolve();
						await release.promise;
					}
					return `answer ${questions.length}`;
				},
			});
			const view = createTuiLiveView(core);
			const auxiliary = createTuiAuxiliaryController(core, view, {
				collectConnections: () =>
					Promise.resolve([
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
					]),
			});

			const active = auxiliary.startSide("first");
			await started.promise;
			await auxiliary.startSide("second");
			await auxiliary.startSide("third");
			release.resolve();
			await active;

			expect(questions).toEqual(["first", "second"]);
			await auxiliary.shutdown();
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cancels pending auxiliary input when the application shuts down", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-side-shutdown-"));
		try {
			const started = deferred();
			const questions: string[] = [];
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				runAuxiliary: async (request) => {
					questions.push(request.question);
					if (questions.length > 1) return "unexpected";
					started.resolve();
					await new Promise<void>((_resolve, reject) => {
						request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
					});
					return "unreachable";
				},
			});
			const view = createTuiLiveView(core);
			const auxiliary = createTuiAuxiliaryController(core, view, {
				collectConnections: () =>
					Promise.resolve([
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
					]),
			});

			void auxiliary.startSide("active");
			await started.promise;
			await auxiliary.startSide("must not run");
			await auxiliary.shutdown();

			expect(questions).toEqual(["active"]);
			expect(auxiliary.isRunning()).toBe(false);
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists its own history across restart without receiving main context", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-side-command-"));
		const statePath = join(root, "state.sqlite");
		const projectRoot = join(root, "project");
		try {
			const firstRequests: TuiAuxiliaryRequest[] = [];
			const firstCore = createTuiLiveCore({
				projectRoot,
				statePath,
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				runAuxiliary: async (request) => {
					firstRequests.push(request);
					return "Remembered SIDE_842";
				},
			});
			const firstView = createTuiLiveView(firstCore);
			firstView.appendText("MAIN_SECRET_731");
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
			const firstAuxiliary = createTuiAuxiliaryController(firstCore, firstView, {
				collectConnections: () => Promise.resolve(connections),
			});

			await firstAuxiliary.startSide("Remember SIDE_842");

			expect(firstRequests[0]).toMatchObject({
				kind: "side",
				question: "Remember SIDE_842",
				history: [],
			});
			expect(firstRequests[0]).not.toHaveProperty("observation");
			expect(JSON.stringify(firstRequests[0])).not.toContain("MAIN_SECRET_731");
			await firstAuxiliary.shutdown();
			if (firstView.workAnimationTimer) clearInterval(firstView.workAnimationTimer);
			firstCore.database.close();

			const secondRequests: TuiAuxiliaryRequest[] = [];
			const secondCore = createTuiLiveCore({
				projectRoot,
				statePath,
				runTask: async () => undefined,
				resumeTask: async () => undefined,
				runAuxiliary: async (request) => {
					secondRequests.push(request);
					return "Continued Side Chat";
				},
			});
			const secondView = createTuiLiveView(secondCore);
			const secondAuxiliary = createTuiAuxiliaryController(secondCore, secondView, {
				collectConnections: () => Promise.resolve(connections),
			});

			await secondAuxiliary.startSide("Continue");

			expect(secondRequests[0]?.history).toEqual([{ question: "Remember SIDE_842", answer: "Remembered SIDE_842" }]);
			await secondAuxiliary.shutdown();
			if (secondView.workAnimationTimer) clearInterval(secondView.workAnimationTimer);
			secondCore.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
