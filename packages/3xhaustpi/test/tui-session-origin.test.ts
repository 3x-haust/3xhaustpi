import { describe, expect, it } from "vitest";
import { conversationSessionFromEvent } from "../src/tui-live-events.ts";

describe("TUI conversation session origin", () => {
	it("accepts only native conversation session events", () => {
		expect(
			conversationSessionFromEvent({
				type: "session.started",
				runtimeKind: "semantic-checkpoint",
				sessionId: "session_legacy",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
				objective: "inspect",
			}),
		).toBeUndefined();
		expect(
			conversationSessionFromEvent({
				type: "session.started",
				runtimeKind: "native-agent",
				sessionId: "agent_session_native",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
				objective: "inspect",
			}),
		).toEqual({
			sessionId: "agent_session_native",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		});
	});
});
