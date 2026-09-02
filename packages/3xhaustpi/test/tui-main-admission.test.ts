import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAccount } from "../src/account-selection.ts";
import type { ProviderConnection } from "../src/connections.ts";
import { createTuiAutocompleteController } from "../src/tui-live-autocomplete.ts";
import { createTuiDesktopController } from "../src/tui-live-desktop.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { installTuiSubmission } from "../src/tui-live-submit.ts";
import type { TuiTaskController } from "../src/tui-live-tasks.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { createTuiWorkspaceCommands } from "../src/tui-live-workspace.ts";
import { stripAnsi } from "../src/tui-text.ts";

const connectionFixture = vi.hoisted(
	(): {
		beforeReturn?: () => Promise<void>;
		error?: Error;
		providers: ProviderConnection[];
	} => ({ providers: [] }),
);

vi.mock("../src/connections.ts", () => ({
	collectProviderConnections: async () => {
		await connectionFixture.beforeReturn?.();
		if (connectionFixture.error) throw connectionFixture.error;
		return connectionFixture.providers;
	},
}));

const cleanups: Array<() => void> = [];

beforeEach(() => {
	connectionFixture.providers = [];
	connectionFixture.beforeReturn = undefined;
	connectionFixture.error = undefined;
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function account(id: string, providerId: string): ModelAccount {
	return { id, providerId, label: id, detail: "test", active: true };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function provider(accounts: readonly ModelAccount[]): ProviderConnection {
	return {
		id: "openai-codex",
		name: "OpenAI Codex",
		modelCount: 1,
		modelIds: ["gpt-5.6-terra"],
		authMethods: [],
		configured: accounts.length > 0,
		accounts,
	};
}

function harness() {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-main-admission-"));
	const core = createTuiLiveCore({
		projectRoot: join(root, "project"),
		statePath: join(root, "state.sqlite"),
		runTask: async () => undefined,
		resumeTask: async () => undefined,
	});
	const view = createTuiLiveView(core);
	const workspace = createTuiWorkspaceCommands(core, view);
	const autocomplete = createTuiAutocompleteController(core, workspace);
	const tasks: TuiTaskController = {
		drainQueue: vi.fn(),
		startResume() {},
	};
	installTuiSubmission({
		core,
		view,
		tasks,
		workspace,
		desktop: createTuiDesktopController(core, view),
		autocomplete,
		requestExit() {},
	});
	cleanups.push(() => {
		if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { autocomplete, core, tasks };
}

describe("durable main turn admission", () => {
	it("binds an eligible account, enqueues once, renders the user turn, and drains", async () => {
		connectionFixture.providers = [provider([account("openai-codex:alpha", "openai-codex")])];
		const { core, tasks } = harness();

		await core.editor.onSubmit?.("inspect the project");
		await core.editor.onSubmit?.("inspect the project");

		expect(core.database.listTuiRequests(core.state.projectRoot)).toEqual([
			expect.objectContaining({
				objective: "inspect the project",
				position: 1,
				status: "queued",
				binding: {
					version: 1,
					conversationGeneration: 0,
					sessionId: null,
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					accountId: "openai-codex:alpha",
					thinkingLevel: "medium",
				},
			}),
		]);
		expect(core.database.findTuiProviderAccount(core.state.projectRoot, "openai-codex")).toBe("openai-codex:alpha");
		expect(core.transcriptEntries.map(stripAnsi).join("\n")).toContain("inspect the project");
		expect(core.transcriptEntries.map(stripAnsi).join("\n")).toContain("already queued 1");
		expect(tasks.drainQueue).toHaveBeenCalledTimes(2);
	});

	it("restores the editor and does not enqueue when no account is eligible", async () => {
		connectionFixture.providers = [provider([])];
		const { core, tasks } = harness();

		await core.editor.onSubmit?.("inspect the project");

		expect(core.database.listTuiRequests(core.state.projectRoot)).toEqual([]);
		expect(core.editor.getText()).toBe("inspect the project");
		expect(core.transcriptEntries.map(stripAnsi).join("\n")).toContain("No selected account for openai-codex");
		expect(tasks.drainQueue).not.toHaveBeenCalled();
	});

	it("uses one immutable project and model snapshot across asynchronous account discovery", async () => {
		connectionFixture.providers = [provider([account("openai-codex:alpha", "openai-codex")])];
		const started = deferred();
		const release = deferred();
		connectionFixture.beforeReturn = async () => {
			started.resolve();
			await release.promise;
		};
		const { core } = harness();
		const originalProject = core.state.projectRoot;

		const submission = core.editor.onSubmit?.("snapshot this request");
		await started.promise;
		core.state.projectRoot = `${originalProject}-other`;
		core.state.provider = "anthropic";
		core.state.model = "claude-opus-4-1";
		release.resolve();
		await submission;

		expect(core.database.listTuiRequests(originalProject)).toEqual([
			expect.objectContaining({
				projectPath: originalProject,
				objective: "snapshot this request",
				binding: expect.objectContaining({
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				}),
			}),
		]);
	});

	it("restores the prompt and renders discovery failures instead of rejecting silently", async () => {
		connectionFixture.error = new Error("credential discovery offline");
		const { core, tasks } = harness();

		await expect(core.editor.onSubmit?.("keep this prompt")).resolves.toBeUndefined();

		expect(core.editor.getText()).toBe("keep this prompt");
		expect(core.transcriptEntries.map(stripAnsi).join("\n")).toContain("credential discovery offline");
		expect(tasks.drainQueue).not.toHaveBeenCalled();
	});

	it("does not let the hidden provider command bypass eligible accounts", async () => {
		connectionFixture.providers = [provider([account("openai-codex:alpha", "openai-codex")])];
		const { core } = harness();

		await core.editor.onSubmit?.("/provider anthropic");

		expect(core.state.provider).toBe("openai-codex");
		expect(core.state.model).toBe("gpt-5.6-terra");
		expect(core.transcriptEntries.map(stripAnsi).join("\n")).toContain(
			"No enabled logged-in account for provider anthropic",
		);
	});
});
