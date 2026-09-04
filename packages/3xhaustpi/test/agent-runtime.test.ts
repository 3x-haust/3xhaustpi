import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	AgentSessionNotFoundError,
	cacheRoutingOptions,
	openAgentSessionManager,
	providerAuxiliaryCacheAffinity,
	providerCacheAffinity,
} from "../src/agent-runtime.ts";
import { installProviderCacheRouting } from "../src/agent-runtime-provider.ts";

describe("native agent cache routing", () => {
	it("keeps project/provider/model affinity deterministic and isolated", () => {
		const first = providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra");
		expect(providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra")).toBe(first);
		expect(providerCacheAffinity("/other", "openai-codex", "gpt-5.6-terra")).not.toBe(first);
		expect(providerCacheAffinity("/project", "openai-codex", "gpt-5.4")).not.toBe(first);
		expect(providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra", "SYSTEM_A")).not.toBe(
			providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra", "SYSTEM_B"),
		);
		expect(first).toMatch(/^3xhaustpi_[0-9a-f]{32}$/u);
	});

	it("isolates Side Chat and BTW cache identity from main and each other", () => {
		const main = providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra", "SYSTEM");
		const side = providerAuxiliaryCacheAffinity(
			"side",
			"side_chat_1",
			"/project",
			"openai-codex",
			"gpt-5.6-terra",
			"account-a",
			"SYSTEM",
		);
		expect(
			providerAuxiliaryCacheAffinity(
				"side",
				"side_chat_1",
				"/project",
				"openai-codex",
				"gpt-5.6-terra",
				"account-a",
				"SYSTEM",
			),
		).toBe(side);
		expect(side).not.toBe(main);
		expect(
			providerAuxiliaryCacheAffinity(
				"btw",
				"btw_run_1",
				"/project",
				"openai-codex",
				"gpt-5.6-terra",
				"account-a",
				"SYSTEM",
			),
		).not.toBe(side);
		expect(
			providerAuxiliaryCacheAffinity(
				"side",
				"side_chat_2",
				"/project",
				"openai-codex",
				"gpt-5.6-terra",
				"account-a",
				"SYSTEM",
			),
		).not.toBe(side);
		expect(
			providerAuxiliaryCacheAffinity(
				"side",
				"side_chat_1",
				"/project",
				"openai-codex",
				"gpt-5.6-terra",
				"account-b",
				"SYSTEM",
			),
		).not.toBe(side);
		expect(
			providerAuxiliaryCacheAffinity(
				"side",
				"side_chat_1",
				"/project",
				"openai-codex",
				"gpt-5.6-terra",
				"account-a",
				"SYSTEM_CHANGED",
			),
		).not.toBe(side);
	});

	it("restores one required native policy before the provider call", () => {
		const providerContexts: Context[] = [];
		const requiredSystemPrompt =
			"NATIVE_BASE\n\n<user_global_instructions>\nGLOBAL_POLICY_SENTINEL\n</user_global_instructions>";
		const baseStream = vi.fn(((_model, context) => {
			providerContexts.push(structuredClone(context));
			return {};
		}) as AgentSession["agent"]["streamFunction"]);
		const session = {
			systemPrompt: requiredSystemPrompt,
			agent: { streamFunction: baseStream },
		} as unknown as AgentSession;
		const model = fauxProvider().getModel();
		const replacementContext: Context = {
			systemPrompt: "REPLACEMENT_ONLY",
			messages: [],
			tools: [],
		};

		installProviderCacheRouting(session, "cache_key", undefined, "GLOBAL_POLICY_SENTINEL");
		installProviderCacheRouting(session, "cache_key", undefined, "GLOBAL_POLICY_SENTINEL");
		session.agent.streamFunction(model, replacementContext);

		const enforced = providerContexts[0]?.systemPrompt ?? "";
		expect(enforced.startsWith(requiredSystemPrompt)).toBe(true);
		expect(enforced.split("GLOBAL_POLICY_SENTINEL")).toHaveLength(2);
		expect(enforced.split("REPLACEMENT_ONLY")).toHaveLength(2);
		expect(baseStream).toHaveBeenCalledOnce();
	});

	it("keeps the compaction contract first and adds global policy once", () => {
		const providerContexts: Context[] = [];
		const baseStream = vi.fn(((_model, context) => {
			providerContexts.push(structuredClone(context));
			return {};
		}) as AgentSession["agent"]["streamFunction"]);
		const session = {
			systemPrompt: "NATIVE_BASE\n\n<user_global_instructions>\nGLOBAL_POLICY_SENTINEL\n</user_global_instructions>",
			agent: { streamFunction: baseStream },
		} as unknown as AgentSession;
		const summaryContext: Context = {
			systemPrompt: "You are a context summarization assistant. Summarize.",
			messages: [],
			tools: [],
		};

		installProviderCacheRouting(session, "cache_key", undefined, "GLOBAL_POLICY_SENTINEL");
		session.agent.streamFunction(fauxProvider().getModel(), summaryContext);

		const enforced = providerContexts[0]?.systemPrompt ?? "";
		expect(enforced.startsWith("You are a context summarization assistant.")).toBe(true);
		expect(enforced.split("GLOBAL_POLICY_SENTINEL")).toHaveLength(2);
		expect(enforced).not.toContain("NATIVE_BASE");
	});

	it("uses long-lived main affinity and an isolated short compaction affinity", () => {
		expect(cacheRoutingOptions("cache_key", "You are the coding agent.")).toEqual({
			cacheRetention: "long",
			sessionId: "cache_key",
			promptCacheKey: "cache_key",
		});
		expect(cacheRoutingOptions("cache_key", "You are a context summarization assistant. Summarize.")).toEqual({
			cacheRetention: "short",
			sessionId: "cache_key_compaction",
			promptCacheKey: "cache_key_compaction",
		});
	});

	it("owns Codex WebSocket cleanup with the disposable agent session", () => {
		let routedOptions: Parameters<AgentSession["agent"]["streamFunction"]>[2];
		const baseStream = vi.fn(((_model, _context, options) => {
			routedOptions = options;
			return {};
		}) as AgentSession["agent"]["streamFunction"]);
		const session = {
			systemPrompt: "NATIVE_BASE",
			sessionManager: { getSessionId: () => "session_owned" },
			agent: { streamFunction: baseStream },
		} as unknown as AgentSession;
		const model = {
			...fauxProvider().getModel(),
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.6-terra",
		} satisfies Model<"openai-codex-responses">;

		installProviderCacheRouting(session, "stable_cache_key", undefined);
		session.agent.streamFunction(model, { systemPrompt: "NATIVE_BASE", messages: [], tools: [] });

		expect(routedOptions).toMatchObject({
			cacheRetention: "long",
			promptCacheKey: "stable_cache_key",
			sessionId: "session_owned",
			transport: "websocket",
		});
	});

	it("reopens only the exact persisted session for the same project", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-agent-session-"));
		const projectRoot = join(root, "project");
		const sessionDir = join(root, "sessions");
		const sessionId = "01a02620-d48b-7bec-bfe9-e1a99c466b87";
		try {
			const created = SessionManager.create(projectRoot, sessionDir, { id: sessionId });
			created.appendMessage({ role: "user", content: "continue", timestamp: 1 });
			created.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "continued" }],
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			const reopened = await openAgentSessionManager(projectRoot, sessionId, sessionDir);
			expect(reopened.getSessionId()).toBe(sessionId);
			await expect(openAgentSessionManager(projectRoot, "session_missing", sessionDir)).rejects.toBeInstanceOf(
				AgentSessionNotFoundError,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
