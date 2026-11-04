import type {
	BetaCacheControlEphemeral as CacheControlEphemeral,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildAnthropicParams } from "../src/api/anthropic-messages.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { CacheRetention, Context, Model } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "offline-fixture",
	name: "Offline fixture",
	api: "anthropic-messages",
	provider: "faux",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function context(): Context {
	return {
		systemPrompt: "Stable system instructions",
		tools: ["read", "bash"].map((name) => ({
			name,
			description: `Stable ${name} description`,
			parameters: Type.Object({ path: Type.String() }),
		})),
		messages: [
			{ role: "user", content: "first", timestamp: 0 },
			fauxAssistantMessage("reply", { timestamp: 1 }),
			{ role: "user", content: "second", timestamp: 2 },
		],
	};
}

function controls(params: MessageCreateParamsStreaming): CacheControlEphemeral[] {
	return [
		...(Array.isArray(params.system) ? params.system.flatMap((block) => block.cache_control ?? []) : []),
		...(params.tools ?? []).flatMap((tool) => ("cache_control" in tool ? (tool.cache_control ?? []) : [])),
		...params.messages.flatMap((message) =>
			typeof message.content === "string"
				? []
				: message.content.flatMap((block) => ("cache_control" in block ? (block.cache_control ?? []) : [])),
		),
	];
}

describe("Anthropic production request builder (pure construction, faux transcript, no clients or keys)", () => {
	it.each(
		[false, true].flatMap((oauth) =>
			(["none", "short", "long"] satisfies CacheRetention[]).map((retention) => ({ oauth, retention })),
		),
	)(
		"constructs OAuth=$oauth retention=$retention with correct identity, count, TTL, and no input mutation",
		({ oauth, retention }) => {
			const input = context();
			const before = JSON.stringify(input);
			const params = buildAnthropicParams(model, input, oauth, { cacheRetention: retention });
			const system = Array.isArray(params.system) ? params.system : [];

			expect(system.map((block) => block.text)).toEqual([
				...(oauth ? ["You are Claude Code, Anthropic's official CLI for Claude."] : []),
				"Stable system instructions",
			]);
			expect(params.tools?.map((tool) => ("name" in tool ? tool.name : undefined))).toEqual(
				oauth ? ["Read", "Bash"] : ["read", "bash"],
			);
			expect(controls(params)).toEqual(
				retention === "none"
					? []
					: Array.from({ length: 4 }, () => ({
							type: "ephemeral",
							...(retention === "long" ? { ttl: "1h" } : {}),
						})),
			);
			expect(JSON.stringify(input)).toBe(before);
		},
	);

	it.each([false, true])("resolves long retention from scoped environment with OAuth=%s", (oauth) => {
		const params = buildAnthropicParams(model, context(), oauth, { env: { PI_CACHE_RETENTION: "long" } });
		expect(controls(params)).toHaveLength(4);
		expect(controls(params).every((control) => control.ttl === "1h")).toBe(true);
	});

	it.each([false, true])("honors long-retention and tool-marker compatibility with OAuth=%s", (oauth) => {
		const params = buildAnthropicParams(
			{ ...model, compat: { supportsLongCacheRetention: false, supportsCacheControlOnTools: false } },
			context(),
			oauth,
			{ cacheRetention: "long" },
		);
		expect(controls(params)).toEqual(Array.from({ length: 3 }, () => ({ type: "ephemeral" })));
		expect(params.tools?.some((tool) => "cache_control" in tool)).toBe(false);
	});

	it.each([false, true])("handles missing custom system and tools with OAuth=%s", (oauth) => {
		const params = buildAnthropicParams(model, { messages: context().messages }, oauth, { cacheRetention: "long" });
		expect(controls(params)).toHaveLength(oauth ? 3 : 2);
		if (oauth) {
			expect(params.system).toEqual([
				{
					type: "text",
					text: "You are Claude Code, Anthropic's official CLI for Claude.",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			]);
		} else {
			expect(params.system).toBeUndefined();
		}
		expect(params.tools).toBeUndefined();
	});

	it("keeps historical string-user representation stable as conversation boundaries move", () => {
		const input = context();
		const first = buildAnthropicParams(model, input, false, { cacheRetention: "long" });
		input.messages.push(fauxAssistantMessage("another reply"), { role: "user", content: "third", timestamp: 3 });
		const next = buildAnthropicParams(model, input, false, { cacheRetention: "long" });

		expect(first.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "first" }] });
		expect(next.messages[0]).toEqual(first.messages[0]);
	});
});
