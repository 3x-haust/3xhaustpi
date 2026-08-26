import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTuiTaskEvents } from "../src/tui-live-events.ts";
import { createTuiLiveCore } from "../src/tui-live-state.ts";
import { buildTuiStatusSnapshot, startStatus } from "../src/tui-live-status.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";
import { TuiStatusOverlay } from "../src/tui-status-overlay.ts";
import { cellWidth, stripAnsi } from "../src/tui-text.ts";

describe("durable execution status", () => {
	it("renders recovered agent and tool hierarchy from reopened state", () => {
		// Given: a failed operation with persisted nested agent and tool events.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-status-execution-"));
		const projectRoot = join(root, "project");
		const statePath = join(root, "state.sqlite");
		const first = createTuiLiveCore({
			projectRoot,
			statePath,
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		first.database.enqueueTuiRequest({
			requestId: "operation_graph",
			projectPath: projectRoot,
			fingerprint: "operation_graph",
			objective: "inspect authentication",
		});
		const claim = first.database.claimNextTuiRequest(projectRoot, {
			ownerId: "host_a",
			now: "2026-08-26T00:00:00.000Z",
			leaseMs: 60_000,
		});
		if (!claim) throw new Error("Expected operation claim");
		first.database.recordTuiExecutionEvent(
			claim.id,
			{ ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch, now: "2026-08-26T00:00:00.100Z" },
			{
				type: "node.started",
				nodeId: "agent_review",
				parentNodeId: claim.id,
				kind: "agent",
				label: "review",
			},
		);
		first.database.recordTuiExecutionEvent(
			claim.id,
			{ ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch, now: "2026-08-26T00:00:00.200Z" },
			{
				type: "node.started",
				nodeId: "call_read",
				parentNodeId: "agent_review",
				kind: "tool",
				label: "read",
			},
		);
		first.database.recordTuiExecutionEvent(
			claim.id,
			{ ownerId: claim.ownerId, leaseEpoch: claim.leaseEpoch, now: "2026-08-26T00:00:00.300Z" },
			{
				type: "node.completed",
				nodeId: "call_read",
				success: true,
				durationMs: 12.5,
				summary: "read done",
			},
		);
		first.database.completeTuiRequest(claim.id, "failed", {
			ownerId: claim.ownerId,
			leaseEpoch: claim.leaseEpoch,
			now: "2026-08-26T00:00:01.000Z",
		});
		first.database.close();

		// When: status is built from the same SQLite state after restart.
		const reopened = createTuiLiveCore({
			projectRoot,
			statePath,
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(reopened);
		const overlay = new TuiStatusOverlay(buildTuiStatusSnapshot(reopened, view), () => 12, {
			close: () => {},
			invalidate: () => {},
		});
		const lines = overlay.render(76);
		const rendered = stripAnsi(lines.join("\n"));

		// Then: hierarchy, duration, recovered failure, and terminal bounds are visible.
		expect(rendered).toContain("agent review");
		expect(rendered).toContain("read");
		expect(rendered).toContain("12.5 ms");
		expect(rendered).toContain("failed: unfinished");
		expect(lines.every((line) => cellWidth(stripAnsi(line)) <= 76)).toBe(true);
		reopened.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("releases status overlay ownership when blocking approval begins", async () => {
		// Given: a read-only status overlay above the active conversation.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-status-approval-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);
		startStatus(core, view);
		expect(core.ui.hasOverlay()).toBe(true);

		// When: a patch enters the blocking approval boundary.
		const approval = createTuiTaskEvents(core, view).requestApproval({
			patchId: "patch_status",
			targetRevision: "revision_a",
			diff: "diff --git a/file.txt b/file.txt\n+changed",
			files: ["file.txt"],
		});

		// Then: the review owns input and the inspection overlay is gone.
		expect(core.ui.hasOverlay()).toBe(false);
		core.state.approvalResolve?.(false);
		expect(await approval).toBe(false);
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps internal metric identity out of response status", () => {
		// Given: a provider session has started without a measured model response.
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-status-metrics-"));
		const core = createTuiLiveCore({
			projectRoot: join(root, "project"),
			statePath: join(root, "state.sqlite"),
			runTask: async () => undefined,
			resumeTask: async () => undefined,
		});
		const view = createTuiLiveView(core);
		const events = createTuiTaskEvents(core, view);
		events.onTaskEvent({
			type: "session.started",
			runtimeKind: "native-agent",
			sessionId: "session_metrics",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			objective: "measure response",
		});

		// When: status is inspected before and after the first model measurement.
		const before = buildTuiStatusSnapshot(core, view);
		events.onTaskEvent({
			type: "model.completed",
			responseId: "response_metrics",
			usage: { input: 100, output: 25, cacheRead: 75, cacheWrite: 0 },
			durationMs: 1_000,
		});
		const after = buildTuiStatusSnapshot(core, view);

		// Then: internal scope stays hidden and only real provider-turn metrics appear.
		expect(core.state.metricsScope).toContain("\u0000");
		expect(before.latestResponse).toBeUndefined();
		expect(after.latestResponse).toEqual({
			source: "provider turn",
			outputTokens: 25,
			durationMs: 1_000,
			cacheHitPercent: 100,
		});
		core.database.close();
		rmSync(root, { recursive: true, force: true });
	});
});
