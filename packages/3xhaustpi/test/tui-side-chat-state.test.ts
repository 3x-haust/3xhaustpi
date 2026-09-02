import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreeXhaustState } from "../src/state.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-side-chat-"));
	directories.push(root);
	return {
		databasePath: join(root, "state.sqlite"),
		projectPath: join(root, "project"),
	};
}

const binding = {
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	accountId: "openai-codex:alpha",
	thinkingLevel: "medium" as const,
};

describe("durable Side Chat state", () => {
	it("creates one stable project chat and preserves completed turns across reopen", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		const chat = state.sideChats.getOrCreate(projectPath, "2026-09-02T00:00:00.000Z");
		const repeated = state.sideChats.getOrCreate(projectPath, "2026-09-02T00:00:01.000Z");
		expect(repeated.chatId).toBe(chat.chatId);
		const turn = state.sideChats.begin({
			projectPath,
			turnId: "side_turn_1",
			question: "Remember SIDE_842",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:02.000Z",
		});
		state.sideChats.complete(turn.turnId, {
			ownerId: "host-a",
			leaseEpoch: turn.leaseEpoch,
			answer: "I will remember SIDE_842",
			now: "2026-09-02T00:00:02.500Z",
		});
		state.close();

		const reopened = new ThreeXhaustState(databasePath);
		expect(reopened.sideChats.listCompleted(projectPath)).toEqual([
			expect.objectContaining({
				turnId: "side_turn_1",
				sequence: 1,
				question: "Remember SIDE_842",
				answer: "I will remember SIDE_842",
				status: "completed",
			}),
		]);
		expect(reopened.sideChats.latestCompleted(projectPath)?.turnId).toBe("side_turn_1");
		reopened.close();
	});

	it("persists failed and canceled turns but excludes them from completed history", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		const failed = state.sideChats.begin({
			projectPath,
			turnId: "side_failed",
			question: "fail",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:00.000Z",
		});
		state.sideChats.terminate(failed.turnId, {
			ownerId: "host-a",
			leaseEpoch: failed.leaseEpoch,
			status: "failed",
			outcome: "provider-error",
			now: "2026-09-02T00:00:00.100Z",
		});
		const canceled = state.sideChats.begin({
			projectPath,
			turnId: "side_canceled",
			question: "cancel",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:00.200Z",
		});
		state.sideChats.terminate(canceled.turnId, {
			ownerId: "host-a",
			leaseEpoch: canceled.leaseEpoch,
			status: "canceled",
			outcome: "user-canceled",
			now: "2026-09-02T00:00:00.300Z",
		});

		expect(state.sideChats.list(projectPath).map(({ status }) => status)).toEqual(["failed", "canceled"]);
		expect(state.sideChats.listCompleted(projectPath)).toEqual([]);
		expect(state.sideChats.latestCompleted(projectPath)).toBeUndefined();
		state.close();
	});

	it("fences a live turn from another owner", () => {
		const { databasePath, projectPath } = fixture();
		const first = new ThreeXhaustState(databasePath);
		const second = new ThreeXhaustState(databasePath);
		first.sideChats.begin({
			projectPath,
			turnId: "side_live",
			question: "first",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:00.000Z",
		});

		expect(() =>
			second.sideChats.begin({
				projectPath,
				turnId: "side_blocked",
				question: "second",
				binding,
				ownerId: "host-b",
				leaseMs: 1_000,
				now: "2026-09-02T00:00:00.500Z",
			}),
		).toThrow(/already running/u);
		second.close();
		first.close();
	});

	it("recovers an expired running turn as interrupted and permits the next turn", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		state.sideChats.begin({
			projectPath,
			turnId: "side_expired",
			question: "first",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:00.000Z",
		});

		state.sideChats.recoverExpired(projectPath, "2026-09-02T00:00:02.000Z");
		const next = state.sideChats.begin({
			projectPath,
			turnId: "side_next",
			question: "second",
			binding,
			ownerId: "host-b",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:02.100Z",
		});

		expect(state.sideChats.list(projectPath)[0]).toMatchObject({
			turnId: "side_expired",
			status: "failed",
			outcome: "interrupted",
		});
		expect(next.sequence).toBe(2);
		state.close();
	});

	it("rejects stale lease completion after ownership changes", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		const turn = state.sideChats.begin({
			projectPath,
			turnId: "side_fenced",
			question: "first",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:00.000Z",
		});

		expect(() =>
			state.sideChats.complete(turn.turnId, {
				ownerId: "host-a",
				leaseEpoch: turn.leaseEpoch + 1,
				answer: "stale",
				now: "2026-09-02T00:00:00.100Z",
			}),
		).toThrow(/lease/u);
		state.close();
	});

	it("rejects termination after the worker lease expires", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		const turn = state.sideChats.begin({
			projectPath,
			turnId: "side_expired_termination",
			question: "first",
			binding,
			ownerId: "host-a",
			leaseMs: 1_000,
			now: "2026-09-02T00:00:00.000Z",
		});

		expect(() =>
			state.sideChats.terminate(turn.turnId, {
				ownerId: "host-a",
				leaseEpoch: turn.leaseEpoch,
				status: "failed",
				outcome: "provider-error",
				now: "2026-09-02T00:00:02.000Z",
			}),
		).toThrow(/lease/u);
		expect(state.sideChats.list(projectPath)[0]?.status).toBe("running");
		state.close();
	});
});
