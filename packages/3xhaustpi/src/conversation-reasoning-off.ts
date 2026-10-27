import type { Api, Model } from "@earendil-works/pi-ai";

export function payloadField(payload: unknown, path: readonly string[]): unknown {
	let value = payload;
	for (const key of path) {
		if (typeof value !== "object" || value === null || !(key in value)) return undefined;
		value = Reflect.get(value, key);
	}
	return value;
}

const RESPONSES_APIS = new Set<string>(["openai-codex-responses", "openai-responses", "azure-openai-responses"]);

/**
 * Whether the model, not only the adapter, declares an off mode before dispatch.
 * Missing metadata is not evidence of support, except where the payload itself proves it.
 */
export function declaresReasoningOff(model: Model<Api>): boolean {
	const off = model.thinkingLevelMap?.off;
	if (off === null) return false;
	if (RESPONSES_APIS.has(model.api)) return typeof off === "string";
	// Google documents Gemini 2.5 Pro as unable to disable thinking; the shared adapter still sends budget 0.
	if ((model.api === "google-generative-ai" || model.api === "google-vertex") && model.id.includes("2.5-pro"))
		return false;
	return (
		model.api === "openai-completions" ||
		model.api === "anthropic-messages" ||
		model.api === "google-generative-ai" ||
		model.api === "google-vertex" ||
		(model.api === "bedrock-converse-stream" && /anthropic|claude/u.test(model.id))
	);
}

/** Returns the payload to send for an explicit off request, or undefined when the wire body does not disable reasoning. */
export function disabledReasoningPayload(model: Model<Api>, payload: object): object | undefined {
	switch (model.api) {
		case "openai-codex-responses":
		case "openai-responses":
		case "azure-openai-responses": {
			const off = model.thinkingLevelMap?.off;
			if (typeof off !== "string") return undefined;
			const reasoning = payloadField(payload, ["reasoning"]);
			return { ...payload, reasoning: { ...(typeof reasoning === "object" ? reasoning : {}), effort: off } };
		}
		case "openai-completions": {
			const disabled = [["reasoning_effort"], ["reasoning", "effort"], ["thinking"], ["thinking", "type"]].some(
				(path) => ["none", "off", "disabled"].includes(String(payloadField(payload, path))),
			);
			const disabledFlag = [
				["enable_thinking"],
				["reasoning", "enabled"],
				["chat_template_args", "enable_thinking"],
				["chat_template_kwargs", "enable_thinking"],
			].some((path) => payloadField(payload, path) === false);
			return disabled || disabledFlag ? payload : undefined;
		}
		case "google-generative-ai":
		case "google-vertex": {
			// Gemini 3 "off" is encoded as the lowest thinking level, which still thinks.
			const config = [
				["config", "thinkingConfig"],
				["generationConfig", "thinkingConfig"],
			]
				.map((path) => payloadField(payload, path))
				.find((value) => value !== undefined);
			return payloadField(config, ["thinkingBudget"]) === 0 && payloadField(config, ["thinkingLevel"]) === undefined
				? payload
				: undefined;
		}
		case "anthropic-messages":
			return payloadField(payload, ["thinking", "type"]) === "disabled" &&
				payloadField(payload, ["output_config", "effort"]) === undefined
				? payload
				: undefined;
		case "bedrock-converse-stream":
			return payloadField(payload, ["additionalModelRequestFields", "thinking"]) === undefined &&
				payloadField(payload, ["additionalModelRequestFields", "output_config"]) === undefined
				? payload
				: undefined;
		default:
			return undefined;
	}
}
