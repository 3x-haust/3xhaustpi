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
	const directory = mkdtempSync(join(tmpdir(), "3xhaustpi-execution-state-"));
	directories.push(directory);
	return {
		projectPath: join(directory, "project"),
		statePath: join(directory, "state.sqlite"),
	};
}

describe("durable TUI execution projection", () => {
	it("persists and clears the native agent session for a project", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.setTuiAgentSession(projectPath, "agent_session_1");
		state.close();

		const reopened = new ThreeXhaustState(statePath);
		expect(reopened.findTuiAgentSession(projectPath)).toBe("agent_session_1");
		reopened.clearTuiAgentSession(projectPath);
		expect(reopened.findTuiAgentSession(projectPath)).toBeUndefined();
		reopened.close();
	});

	it("claims a resume operation directly without consuming an older queued request", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_older",
			projectPath,
			fingerprint: "fingerprint_older",
			objective: "older request",
		});
		state.enqueueTuiRequest({
			requestId: "operation_resume",
			projectPath,
			fingerprint: "fingerprint_resume",
			objective: "resume checkpoint",
		});

		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			requestId: "operation_resume",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 60_000,
		});

		expect(claim?.id).toBe("operation_resume");
		expect(state.listTuiRequests(projectPath).map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: "operation_older", status: "queued" },
			{ id: "operation_resume", status: "running" },
		]);
		expect(state.listTuiExecutionGraphs(projectPath)[0]?.requestId).toBe("operation_resume");
		state.close();
	});

	it("persists fenced work identities and terminalizes the root atomically", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_graph",
			projectPath,
			fingerprint: "fingerprint_graph",
			objective: "inspect graph",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 60_000,
		});
		if (!claim) throw new Error("Expected operation claim");

		state.recordTuiExecutionEvent(
			claim.id,
			{ ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch, now: "2026-08-23T00:00:00.250Z" },
			{
				type: "node.started",
				nodeId: "call_read",
				parentNodeId: claim.id,
				kind: "tool",
				label: "read",
			},
		);
		state.recordTuiExecutionEvent(
			claim.id,
			{ ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch, now: "2026-08-23T00:00:00.500Z" },
			{
				type: "node.completed",
				nodeId: "call_read",
				success: true,
				durationMs: 12.5,
				summary: "read done",
			},
		);
		state.completeTuiRequest(claim.id, "completed", {
			ownerId: claim.ownerId,
			leaseEpoch: claim.leaseEpoch,
			now: "2026-08-23T00:00:01.000Z",
		});
		state.close();

		const reopened = new ThreeXhaustState(statePath);
		const [projection] = reopened.listTuiExecutionGraphs(projectPath);
		expect(projection).toMatchObject({
			requestId: claim.id,
			objective: "inspect graph",
			status: "completed",
		});
		expect(projection?.graph.nodes.map(({ id, state: nodeState }) => ({ id, state: nodeState }))).toEqual([
			{ id: claim.id, state: "completed" },
			{ id: "call_read", state: "completed" },
		]);
		reopened.close();
	});

	it("rejects execution events from a stale lease", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_stale_graph",
			projectPath,
			fingerprint: "fingerprint_stale_graph",
			objective: "inspect graph",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 60_000,
		});
		if (!claim) throw new Error("Expected operation claim");

		expect(() =>
			state.recordTuiExecutionEvent(
				claim.id,
				{ ownerId: "host_b", leaseEpoch: claim.leaseEpoch, now: "2026-08-23T00:00:00.500Z" },
				{
					type: "node.started",
					nodeId: "call_read",
					parentNodeId: claim.id,
					kind: "tool",
					label: "read",
				},
			),
		).toThrow(/lease owner/u);
		state.close();
	});

	it("terminalizes active descendants when effect recovery fails a graph", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		state.enqueueTuiRequest({
			requestId: "operation_recovered_graph",
			projectPath,
			fingerprint: "fingerprint_recovered_graph",
			objective: "recover graph",
		});
		const claim = state.claimNextTuiRequest(projectPath, {
			ownerId: "host_a",
			now: "2026-08-23T00:00:00.000Z",
			leaseMs: 1_000,
		});
		if (!claim) throw new Error("Expected operation claim");
		state.recordTuiExecutionEvent(
			claim.id,
			{ ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch, now: "2026-08-23T00:00:00.250Z" },
			{
				type: "node.started",
				nodeId: "call_running",
				parentNodeId: claim.id,
				kind: "tool",
				label: "write",
			},
		);
		state.recordTuiRequestEffect(claim.id, {
			ownerId: claim.ownerId,
			leaseEpoch: claim.leaseEpoch,
			effectId: "provider_effect",
			now: "2026-08-23T00:00:00.500Z",
		});

		state.recoverInterruptedTuiRequests(projectPath, "2026-08-23T00:00:02.000Z");

		const [projection] = state.listTuiExecutionGraphs(projectPath);
		expect(projection?.status).toBe("failed");
		expect(projection?.graph.activeNodeIds).toEqual([]);
		expect(projection?.graph.nodes.map(({ id, state: nodeState }) => ({ id, state: nodeState }))).toEqual([
			{ id: claim.id, state: "failed" },
			{ id: "call_running", state: "failed" },
		]);
		state.close();
	});

	it("fences the active conversation head by generation", () => {
		const { projectPath, statePath } = fixture();
		const first = new ThreeXhaustState(statePath);
		const second = new ThreeXhaustState(statePath);

		expect(first.readTuiConversationHead(projectPath)).toEqual({
			generation: 0,
			sessionId: null,
		});
		expect(
			first.compareAndSwapTuiConversationHead(projectPath, {
				expectedGeneration: 0,
				sessionId: "agent_session_a",
			}),
		).toEqual({ generation: 1, sessionId: "agent_session_a" });
		expect(() =>
			second.compareAndSwapTuiConversationHead(projectPath, {
				expectedGeneration: 0,
				sessionId: "agent_session_b",
			}),
		).toThrow(/generation/u);
		expect(second.readTuiConversationHead(projectPath)).toEqual({
			generation: 1,
			sessionId: "agent_session_a",
		});
		first.close();
		second.close();
	});

	it("quarantines an invalid native conversation pointer without losing evidence", () => {
		const { projectPath, statePath } = fixture();
		const state = new ThreeXhaustState(statePath);
		const published = state.compareAndSwapTuiConversationHead(projectPath, {
			expectedGeneration: 0,
			sessionId: "session_legacy",
		});
		state.quarantineTuiConversationHead(projectPath, {
			expectedGeneration: published.generation,
			sessionId: "session_legacy",
			reason: "not a Pi conversation for this project",
		});

		expect(state.readTuiConversationHead(projectPath)).toEqual({
			generation: published.generation + 1,
			sessionId: null,
		});
		expect(state.listQuarantinedTuiSessions(projectPath)).toContainEqual(
			expect.objectContaining({
				sessionId: "session_legacy",
				reason: "not a Pi conversation for this project",
			}),
		);
		state.close();
	});
});
