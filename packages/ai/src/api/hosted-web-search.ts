// Provider-hosted web search: whether a request declares it, the tool definitions, and the per-session fallback
// when a provider rejects the tool.
import type { Api, AssistantMessage, AssistantMessageEvent, Model, StreamOptions } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

/** Environment variable that turns hosted web search on when `StreamOptions.hostedWebSearch` is unset. */
export const HOSTED_WEB_SEARCH_ENV = "PI_HOSTED_WEB_SEARCH";

/** Name of the hosted search tool on every supported API; a function tool with this name keeps it off on Anthropic. */
export const HOSTED_WEB_SEARCH_NAME = "web_search";

/**
 * Anthropic's basic web search tool. It runs on every Claude model and platform, needs no beta header, and calls the
 * search directly, so each `server_tool_use` block carries the query. The later versions (`web_search_20260209`,
 * `web_search_20260318`) search from inside code execution by default, which adds code execution blocks and a
 * container to the transcript.
 */
export const ANTHROPIC_WEB_SEARCH_TOOL = { type: "web_search_20250305", name: HOSTED_WEB_SEARCH_NAME } as const;

/** OpenAI Responses hosted web search, as the Codex CLI declares it. */
export const OPENAI_WEB_SEARCH_TOOL = { type: "web_search" } as const;

/** Sessions whose provider rejected hosted web search; requests in them go without it. */
const rejectedSessions = new Set<string>();

/** Test hook: forget remembered rejections. */
export function resetHostedWebSearchRejections(): void {
	rejectedSessions.clear();
}

/**
 * Runs one provider stream with `hostedWebSearch` resolved to a boolean. When hosted search is on and the provider
 * rejects the request because of it before any output, the session is remembered as rejected and the request runs
 * again without the tool, so the response carries on instead of failing.
 */
export function streamWithHostedWebSearch<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
	run: (options: TOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const key = sessionKey(model, options);
	if (!wantsHostedWebSearch(model, options) || rejectedSessions.has(key)) {
		return run({ ...options, hostedWebSearch: false } as TOptions);
	}
	const outer = new AssistantMessageEventStream();
	void (async () => {
		// `start` is held until the first content event, so a rejection that arrives after it can still be retried.
		let held: AssistantMessageEvent | undefined;
		let forwarded = false;
		for await (const event of run({ ...options, hostedWebSearch: true } as TOptions)) {
			if (!forwarded && event.type === "start") {
				held = event;
				continue;
			}
			if (
				!forwarded &&
				event.type === "error" &&
				event.reason === "error" &&
				!options?.signal?.aborted &&
				isHostedWebSearchRejection(event.error.errorMessage)
			) {
				rejectedSessions.add(key);
				await forwardWithoutHostedSearch(
					outer,
					run({ ...options, hostedWebSearch: false } as TOptions),
					event.error,
				);
				return;
			}
			if (held) outer.push(held);
			held = undefined;
			forwarded = true;
			outer.push(event);
		}
		if (held) outer.push(held);
		outer.end();
	})();
	return outer;
}

async function forwardWithoutHostedSearch(
	outer: AssistantMessageEventStream,
	retry: AssistantMessageEventStream,
	rejected: AssistantMessage,
): Promise<void> {
	for await (const event of retry) {
		const final = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
		if (final) {
			appendAssistantMessageDiagnostic(final, {
				type: "hosted_web_search_fallback",
				timestamp: Date.now(),
				error: { message: rejected.errorMessage ?? "Hosted web search was rejected" },
				details: { reason: "hosted_web_search_rejected" },
			});
		}
		outer.push(event);
	}
	outer.end();
}

/** Whether hosted web search is switched on for this request and the model's API supports it. */
function wantsHostedWebSearch(model: Model<Api>, options: StreamOptions | undefined): boolean {
	if (!supportsHostedWebSearch(model)) return false;
	if (options?.hostedWebSearch !== undefined) return options.hostedWebSearch;
	const value = getProviderEnvValue(HOSTED_WEB_SEARCH_ENV, options?.env)?.trim().toLowerCase();
	return value === "1" || value === "true";
}

/** First-party endpoints only: proxies and other hosts of these APIs do not run the providers' search. */
function supportsHostedWebSearch(model: Model<Api>): boolean {
	switch (model.api) {
		case "anthropic-messages":
			return model.provider === "anthropic";
		case "openai-responses":
			return model.provider === "openai";
		case "openai-codex-responses":
			return model.provider === "openai-codex";
		default:
			return false;
	}
}

function sessionKey(model: Model<Api>, options: StreamOptions | undefined): string {
	return [model.api, model.provider, model.baseUrl, model.id, options?.sessionId ?? ""].join("\u0000");
}

/**
 * A request refused because of the hosted search tool, e.g. Anthropic's 400 "web search is not enabled for this
 * organization" or OpenAI's "Tool 'web_search' is not supported with this model". Rate limits and overload errors
 * that mention search are transient and keep the tool.
 */
export function isHostedWebSearchRejection(message: string | undefined): boolean {
	if (!message || !/web[ _-]?search/i.test(message)) return false;
	return !/\b(429|529)\b|rate.?limit|too many requests|overloaded/i.test(message);
}
