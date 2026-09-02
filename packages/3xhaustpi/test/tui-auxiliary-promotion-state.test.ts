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
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-promotion-state-"));
	directories.push(root);
	return {
		databasePath: join(root, "state.sqlite"),
		projectPath: join(root, "project"),
	};
}

function promotion(kind: "side" | "btw", sourceId: string) {
	return {
		version: 1 as const,
		source: {
			kind,
			sourceId,
			question: "Is the main agent following the requested design?",
			answer: "Change course and implement the requested design.",
			completedAt: "2026-09-02T00:00:00.000Z",
		},
	};
}

describe("durable auxiliary promotion admission", () => {
	it("deduplicates one source across fingerprints and terminal queue states", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		state.enqueueTuiRequest({
			requestId: "normal_older",
			projectPath,
			fingerprint: "normal_fingerprint",
			objective: "older main work",
		});
		const first = state.enqueueTuiRequest({
			requestId: "promoted_side",
			projectPath,
			fingerprint: "promotion_fingerprint_a",
			objective: "[Promoted from Side Chat]",
			promotion: promotion("side", "side_turn_1"),
		});
		const activeDuplicate = state.enqueueTuiRequest({
			requestId: "promoted_side_duplicate",
			projectPath,
			fingerprint: "promotion_fingerprint_b",
			objective: "[Promoted from Side Chat]",
			promotion: promotion("side", "side_turn_1"),
		});

		expect(first.inserted).toBe(true);
		expect(activeDuplicate).toEqual({ request: first.request, inserted: false });
		expect(state.listTuiRequests(projectPath).map(({ id, position }) => ({ id, position }))).toEqual([
			{ id: "normal_older", position: 1 },
			{ id: "promoted_side", position: 2 },
		]);

		const claimed = state.claimNextTuiRequest(projectPath, {
			ownerId: "host-a",
			requestId: "promoted_side",
			now: "2026-09-02T00:00:01.000Z",
			leaseMs: 1_000,
		});
		if (!claimed) throw new Error("Expected promoted request claim");
		state.completeTuiRequest(claimed.id, "completed", {
			ownerId: claimed.ownerId,
			leaseEpoch: claimed.leaseEpoch,
			now: "2026-09-02T00:00:01.500Z",
		});
		const terminalDuplicate = state.enqueueTuiRequest({
			requestId: "promoted_side_after_completion",
			projectPath,
			fingerprint: "promotion_fingerprint_c",
			objective: "[Promoted from Side Chat]",
			promotion: promotion("side", "side_turn_1"),
		});

		expect(terminalDuplicate.inserted).toBe(false);
		expect(terminalDuplicate.request.id).toBe("promoted_side");
		expect(terminalDuplicate.request.status).toBe("completed");
		state.close();

		const reopened = new ThreeXhaustState(databasePath);
		const reopenedDuplicate = reopened.enqueueTuiRequest({
			requestId: "promoted_side_after_restart",
			projectPath,
			fingerprint: "promotion_fingerprint_d",
			objective: "[Promoted from Side Chat]",
			promotion: promotion("side", "side_turn_1"),
		});
		expect(reopenedDuplicate.inserted).toBe(false);
		expect(reopenedDuplicate.request.id).toBe("promoted_side");
		reopened.close();
	});

	it("preserves FIFO while allowing different auxiliary answers", () => {
		const { databasePath, projectPath } = fixture();
		const state = new ThreeXhaustState(databasePath);
		state.enqueueTuiRequest({
			requestId: "normal_older",
			projectPath,
			fingerprint: "normal_fingerprint",
			objective: "older main work",
		});
		const side = state.enqueueTuiRequest({
			requestId: "promoted_side",
			projectPath,
			fingerprint: "side_fingerprint",
			objective: "[Promoted from Side Chat]",
			promotion: promotion("side", "side_turn_1"),
		});
		const btw = state.enqueueTuiRequest({
			requestId: "promoted_btw",
			projectPath,
			fingerprint: "btw_fingerprint",
			objective: "[Promoted from BTW]",
			promotion: promotion("btw", "btw_run_1"),
		});

		expect([side.request.position, btw.request.position]).toEqual([2, 3]);
		expect(state.listTuiRequests(projectPath).map(({ id }) => id)).toEqual([
			"normal_older",
			"promoted_side",
			"promoted_btw",
		]);
		state.close();
	});
});
