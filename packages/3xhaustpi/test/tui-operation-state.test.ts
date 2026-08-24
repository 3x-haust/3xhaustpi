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
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-operation-"));
	directories.push(directory);
	return {
		projectPath: join(directory, "project"),
		statePath: join(directory, "state.sqlite"),
	};
}

describe("durable TUI operation ownership", () => {
	it("fences completion by owner and lease epoch", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_fenced",
			projectPath,
			fingerprint: "fingerprint_fenced",
			objective: "inspect",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 60_000,
		});
		if (!claim) throw new Error("Expected operation claim");
		const foreign = new ThreeXhaustState(statePath);

		expect(() =>
			(
				foreign as unknown as {
					completeTuiRequest(requestId: string, status: "completed" | "failed"): void;
				}
			).completeTuiRequest("operation_fenced", "completed"),
		).toThrow(/lease.*required/u);
		expect(() =>
			foreign.completeTuiRequest("operation_fenced", "completed", {
				ownerId: "host_b",
				leaseEpoch: claim.leaseEpoch,
				now: "2026-08-23T00:00:01.000Z",
			}),
		).toThrow(/lease owner/u);
		expect(() =>
			foreign.completeTuiRequest("operation_fenced", "completed", {
				ownerId: "host_a",
				leaseEpoch: claim.leaseEpoch + 1,
				now: "2026-08-23T00:00:01.000Z",
			}),
		).toThrow(/lease epoch/u);

		foreign.completeTuiRequest("operation_fenced", "completed", {
			ownerId: "host_a",
			leaseEpoch: claim.leaseEpoch,
			now: "2026-08-23T00:00:01.000Z",
		});
		expect(state.listTuiRequests(projectPath)).toEqual([]);
		foreign.close();
		state.close();
	});

	it("does not reclaim a live lease", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_live",
			projectPath,
			fingerprint: "fingerprint_live",
			objective: "inspect",
		});
		state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 60_000,
		});

		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:30.000Z");

		expect(
			state.claimNextTuiRequest(projectPath, {
				ownerId: "host_b",
				now: "2026-08-23T00:00:30.000Z",
				leaseMs: 60_000,
			}),
		).toBeUndefined();
		state.close();
	});

	it("renews a fenced lease without changing its epoch", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_renewed",
			projectPath,
			fingerprint: "fingerprint_renewed",
			objective: "inspect",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!claim) throw new Error("Expected operation claim");
		state.renewTuiRequestLease(claim.id, {
			ownerId: "host_a",
			leaseEpoch: claim.leaseEpoch,
			now: "2026-08-23T00:00:00.500Z",
			leaseMs: 2_000,
		});

		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:01.500Z");

		expect(
			state.claimNextTuiRequest(projectPath, {
				ownerId: "host_b",
				now: "2026-08-23T00:00:01.500Z",
				leaseMs: 1_000,
			}),
		).toBeUndefined();
		state.close();
	});

	it("requeues an expired lease only before an effect boundary", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		for (const requestId of ["operation_safe", "operation_effect"]) {
			state.enqueueTuiRequest({
				requestId,
				projectPath,
				fingerprint: `fingerprint_${requestId}`,
				objective: requestId,
			});
		}
		const safe = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!safe) throw new Error("Expected safe operation claim");
		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:02.000Z");
		const reclaimed = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_b",
			now: "2026-08-23T00:00:02.000Z",
			leaseMs: 1_000,
		});
		expect(reclaimed?.id).toBe("operation_safe");
		if (!reclaimed) throw new Error("Expected reclaimed operation");
		state.completeTuiRequest(reclaimed.id, "failed", {
			ownerId: "host_b",
			leaseEpoch: reclaimed.leaseEpoch,
			now: "2026-08-23T00:00:02.500Z",
		});

		const effect = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_b",
			now: "2026-08-23T00:00:02.000Z",
			leaseMs: 1_000,
		});
		if (!effect) throw new Error("Expected effect operation claim");
		state.recordTuiRequestEffect(effect.id, {
			ownerId: "host_b",
			leaseEpoch: effect.leaseEpoch,
			effectId: "provider_effect",
			now: "2026-08-23T00:00:02.500Z",
		});
		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:04.000Z");

		expect(
			state.claimNextTuiRequest(projectPath, {
				ownerId: "host_c",
				now: "2026-08-23T00:00:04.000Z",
				leaseMs: 1_000,
			}),
		).toBeUndefined();
		expect(state.inspectWorkspace(projectPath).requests).toContainEqual({
			id: "operation_effect",
			position: 2,
			status: "failed",
		});
		state.close();
	});

	it("preserves enqueue-time dispatch binding across reclaim", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_bound",
			projectPath,
			fingerprint: "fingerprint_bound",
			objective: "inspect",
			binding: {
				version: 1,
				conversationGeneration: 7,
				sessionId: "agent_session_a",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
			},
		});
		const first = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		expect(first?.binding).toEqual({
			version: 1,
			conversationGeneration: 7,
			sessionId: "agent_session_a",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		});

		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:02.000Z");
		const reclaimed = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_b",
			now: "2026-08-23T00:00:02.000Z",
			leaseMs: 1_000,
		});
		expect(reclaimed?.binding).toEqual(first?.binding);
		state.close();
	});

	it("persists cancellation and leaves the pending human turn claimable", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		for (const [requestId, objective] of [
			["operation_active", "active task"],
			["operation_pending", "pending human task"],
		] as const) {
			state.enqueueTuiRequest({
				requestId,
				projectPath,
				fingerprint: requestId,
				objective,
			});
		}
		const active = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 60_000,
		});
		if (!active) throw new Error("Expected active operation");
		state.completeTuiRequest(active.id, "canceled", {
			ownerId: active.ownerId,
			leaseEpoch: active.leaseEpoch,
			now: "2026-08-23T00:00:01.000Z",
		});

		expect(state.listTuiRequestHistory(projectPath).find(({ id }) => id === "operation_active")).toMatchObject({
			id: "operation_active",
			status: "failed",
			outcome: "canceled",
		});
		expect(
			state.claimNextTuiRequest(projectPath, {
				ownerId: "host_b",
				now: "2026-08-23T00:00:02.000Z",
				leaseMs: 60_000,
			})?.id,
		).toBe("operation_pending");
		state.close();
	});
});
