import { describe, expect, it } from "vitest";
import { isRuntimeParentMessage } from "../src/tui-runtime-worker-protocol.ts";

const runId = "11111111-1111-4111-8111-111111111111";

describe("TUI runtime worker request validation", () => {
	it("accepts session account and image fields emitted by the real client", () => {
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "run",
					projectRoot: "/tmp/project",
					objective: "Describe [image1]",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					accountId: "openai-codex:acct-a",
					images: [
						{
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=",
							mimeType: "image/png",
						},
					],
				},
			}),
		).toBe(true);
	});

	it("rejects malformed image payloads at the worker boundary", () => {
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "run",
					projectRoot: "/tmp/project",
					objective: "Describe [image1]",
					images: [{ data: "not base64!", mimeType: "image/png" }],
				},
			}),
		).toBe(false);
	});

	it("accepts exact side-question and compaction requests", () => {
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "side-question",
					projectRoot: "/tmp/project",
					question: "What changed?",
					context: "fixture context",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					accountId: "openai-codex:acct-a",
					thinkingLevel: "medium",
				},
			}),
		).toBe(true);
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "compact",
					projectRoot: "/tmp/project",
					sessionId: "session_fixture",
					instructions: "Keep decisions",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					thinkingLevel: "medium",
				},
			}),
		).toBe(true);
	});

	it("accepts an exact cache-warm request without conversation text", () => {
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "cache-warm",
					projectRoot: "/tmp/project",
					sessionId: "session_cache",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					accountId: "openai-codex:acct-a",
					thinkingLevel: "medium",
				},
			}),
		).toBe(true);
	});
});
