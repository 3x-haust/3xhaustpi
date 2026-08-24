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
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-operation-expiry-"));
	directories.push(directory);
	return {
		projectPath: join(directory, "project"),
		statePath: join(directory, "state.sqlite"),
	};
}

describe("durable TUI operation lease expiry", () => {
	it("rejects renewal after expiry and leaves recovery as the requeue path", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_expired_renewal",
			projectPath,
			fingerprint: "fingerprint_expired_renewal",
			objective: "inspect",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!claim) throw new Error("Expected operation claim");

		expect(() =>
			state.renewTuiRequestLease(claim.id, {
				ownerId: claim.ownerId,
				leaseEpoch: claim.leaseEpoch,
				now: "2026-08-23T00:00:01.000Z",
				leaseMs: 1_000,
			}),
		).toThrow(/lease.*expired/u);
		expect(state.listTuiRequests(projectPath)).toContainEqual(
			expect.objectContaining({ id: claim.id, status: "running" }),
		);

		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:01.000Z");
		expect(
			state.claimNextTuiRequest(projectPath, {
				ownerId: "host_b",
				now: "2026-08-23T00:00:01.000Z",
				leaseMs: 1_000,
			})?.id,
		).toBe(claim.id);
		state.close();
	});

	it("rejects an owner execution event after expiry until recovery", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_expired_execution",
			projectPath,
			fingerprint: "fingerprint_expired_execution",
			objective: "inspect",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!claim) throw new Error("Expected operation claim");

		expect(() =>
			state.recordTuiExecutionEvent(
				claim.id,
				{
					ownerId: claim.ownerId,
					leaseEpoch: claim.leaseEpoch,
					now: "2026-08-23T00:00:01.000Z",
				},
				{
					type: "node.started",
					nodeId: "expired_work",
					parentNodeId: claim.id,
					kind: "tool",
					label: "read",
				},
			),
		).toThrow(/lease.*expired/u);
		expect(state.listTuiExecutionGraphs(projectPath)[0]?.graph.nodes).toHaveLength(1);

		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:01.000Z");
		expect(state.listTuiRequests(projectPath)).toContainEqual(
			expect.objectContaining({ id: claim.id, status: "queued" }),
		);
		state.close();
	});

	it("rejects effect recording after expiry and leaves recovery safe to requeue", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_expired_effect",
			projectPath,
			fingerprint: "fingerprint_expired_effect",
			objective: "inspect",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!claim) throw new Error("Expected operation claim");

		expect(() =>
			state.recordTuiRequestEffect(claim.id, {
				ownerId: claim.ownerId,
				leaseEpoch: claim.leaseEpoch,
				effectId: "provider_expired",
				now: "2026-08-23T00:00:01.000Z",
			}),
		).toThrow(/lease.*expired/u);
		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:01.000Z");
		expect(
			state.claimNextTuiRequest(projectPath, {
				ownerId: "host_b",
				now: "2026-08-23T00:00:01.000Z",
				leaseMs: 1_000,
			})?.id,
		).toBe(claim.id);
		state.close();
	});

	it("rejects owner completion after expiry while recovery marks an effect indeterminate", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_expired_completion",
			projectPath,
			fingerprint: "fingerprint_expired_completion",
			objective: "inspect",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!claim) throw new Error("Expected operation claim");
		state.recordTuiRequestEffect(claim.id, {
			ownerId: claim.ownerId,
			leaseEpoch: claim.leaseEpoch,
			effectId: "provider_recorded",
			now: "2026-08-23T00:00:00.500Z",
		});

		expect(() =>
			state.completeTuiRequest(claim.id, "completed", {
				ownerId: claim.ownerId,
				leaseEpoch: claim.leaseEpoch,
				now: "2026-08-23T00:00:01.000Z",
			}),
		).toThrow(/lease.*expired/u);
		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:01.000Z");
		expect(state.inspectWorkspace(projectPath).requests).toContainEqual({
			id: claim.id,
			position: 1,
			status: "failed",
		});
		state.close();
	});
});
