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

	it("accepts structurally isolated Side Chat and main-aware BTW requests", () => {
		const binding = {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			accountId: "openai-codex:acct-a",
			thinkingLevel: "medium",
		};
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "auxiliary",
					kind: "side",
					identity: "side_chat_1",
					projectRoot: "/tmp/project",
					question: "Remember SIDE_842",
					history: [{ question: "First", answer: "First answer" }],
					...binding,
				},
			}),
		).toBe(true);
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: {
					mode: "auxiliary",
					kind: "btw",
					identity: "btw_run_1",
					projectRoot: "/tmp/project",
					question: "What is main doing?",
					history: [{ question: "Earlier", answer: "Earlier answer" }],
					observation: {
						version: 1,
						observedAt: "2026-09-02T00:00:00.000Z",
						sessionId: "session_main",
						activeObjective: "Implement main work",
						phase: "running",
						activeCapabilities: ["read"],
						activeWork: ["Inspect code"],
						queuedObjectives: ["Next task"],
						transcriptTail: "MAIN_FACT_219",
					},
					...binding,
				},
			}),
		).toBe(true);
	});

	it("rejects main context fields from Side Chat and requires a BTW observation", () => {
		const base = {
			mode: "auxiliary",
			identity: "aux_1",
			projectRoot: "/tmp/project",
			question: "Question",
			history: [],
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			thinkingLevel: "medium",
		};
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: { ...base, kind: "side", context: "MAIN_SECRET_731" },
			}),
		).toBe(false);
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: { ...base, kind: "side", observation: { transcriptTail: "MAIN_SECRET_731" } },
			}),
		).toBe(false);
		expect(
			isRuntimeParentMessage({
				type: "start",
				runId,
				request: { ...base, kind: "btw" },
			}),
		).toBe(false);
	});
});
