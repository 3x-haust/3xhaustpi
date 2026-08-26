import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTuiTaskEvents } from "../src/tui-live-events.ts";
import { createTuiLiveCore, resetLiveContextTelemetry } from "../src/tui-live-state.ts";
import { createTuiLiveView } from "../src/tui-live-view.ts";

describe("latest-turn status telemetry", () => {
	it("clears prior response metrics when the same session starts another turn", () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-status-turn-"));
		try {
			const core = createTuiLiveCore({
				projectRoot: join(root, "project"),
				statePath: join(root, "state.sqlite"),
				runTask: async () => undefined,
				resumeTask: async () => undefined,
			});
			const view = createTuiLiveView(core);
			const events = createTuiTaskEvents(core, view);
			const started = {
				type: "session.started" as const,
				runtimeKind: "native-agent" as const,
				sessionId: "session",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
				objective: "turn",
			};
			events.onTaskEvent(started);
			events.onTaskEvent({
				type: "model.completed",
				responseId: "response",
				usage: { input: 1_000, output: 10, cacheRead: 900, cacheWrite: 0 },
				durationMs: 1_000,
			});
			expect(core.state.latestCacheHitRatio).toBeDefined();

			events.onTaskEvent(started);

			expect(core.state.latestCacheHitRatio).toBeUndefined();
			expect(core.state.latestMetricsLine).toBeUndefined();
			expect(core.state.latestContextTokens).toBeDefined();
			expect(core.state.responseOutputTokens).toBe(0);
			expect(core.state.responseDurationMs).toBe(0);
			events.onTaskEvent({ ...started, sessionId: "different-session" });
			expect(core.state.latestContextTokens).toBeUndefined();
			resetLiveContextTelemetry(core.state);
			core.state.model = "gpt-5.3-codex-spark";
			events.onTaskEvent({
				type: "model.completed",
				responseId: "late-old-model-response",
				usage: { input: 1_000, output: 100, cacheRead: 900, cacheWrite: 0 },
				durationMs: 1_000,
			});
			expect(core.state.latestContextTokens).toBeUndefined();
			if (view.workAnimationTimer) clearInterval(view.workAnimationTimer);
			core.database.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
