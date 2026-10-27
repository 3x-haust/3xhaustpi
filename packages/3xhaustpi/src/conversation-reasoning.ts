import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ConversationInput } from "./coding-runtime-contracts.ts";

function payloadField(payload: unknown, path: readonly string[]): unknown {
	let value = payload;
	for (const key of path) {
		if (typeof value !== "object" || value === null || !(key in value)) return undefined;
		value = Reflect.get(value, key);
	}
	return value;
}

/** Resolve provider values back to pi levels; let each installed adapter encode its own wire format. */
export function conversationReasoningOptions(
	model: Model<Api>,
	effort: ConversationInput["reasoningEffort"],
): { readonly reasoning?: SimpleStreamOptions["reasoning"]; readonly onPayload?: (payload: unknown) => unknown } {
	if (effort === undefined) return {};
	const unsupported = () =>
		new RangeError(`Unsupported reasoning effort ${JSON.stringify(effort)} for ${model.provider}/${model.id}`);
	const supported = getSupportedThinkingLevels(model);
	const level =
		effort === "none"
			? undefined
			: supported.find(
					(candidate) =>
						candidate !== "off" && (model.thinkingLevelMap?.[candidate] ?? candidate).toLowerCase() === effort,
				);
	if (!model.reasoning || (effort === "none" ? !supported.includes("off") : level === undefined || level === "off")) {
		throw unsupported();
	}
	return {
		...(level !== undefined && level !== "off" ? { reasoning: level } : {}),
		onPayload: (payload: unknown) => {
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw unsupported();
			if (effort === "none") {
				if (model.api === "openai-completions") {
					const disabled = [
						["reasoning_effort"],
						["reasoning", "effort"],
						["thinking"],
						["thinking", "type"],
					].some((path) => ["none", "off", "disabled"].includes(String(payloadField(payload, path))));
					const disabledFlag = [
						["enable_thinking"],
						["reasoning", "enabled"],
						["chat_template_args", "enable_thinking"],
						["chat_template_kwargs", "enable_thinking"],
					].some((path) => payloadField(payload, path) === false);
					if (!disabled && !disabledFlag) throw unsupported();
				}
				// Other adapters already encode off using their native controls. Codex omits it by default.
				return model.api === "openai-codex-responses" ? { ...payload, reasoning: { effort: "none" } } : payload;
			}
			const encoded = [
				["reasoning_effort"],
				["reasoningEffort"],
				["reasoning", "effort"],
				["output_config", "effort"],
				["additionalModelRequestFields", "output_config", "effort"],
				["config", "thinkingConfig", "thinkingLevel"],
				["options", "reasoning"],
				["thinking"],
			]
				.map((path) => payloadField(payload, path))
				.filter((value): value is string => typeof value === "string");
			// Reject adapters that silently substitute a different effort (e.g. Mistral low -> high).
			if (encoded.some((value) => value.toLowerCase() !== effort)) throw unsupported();
			const nativeControls = [
				["thinking", "type"],
				["enable_thinking"],
				["chat_template_args", "enable_thinking"],
				["chat_template_kwargs", "enable_thinking"],
				["reasoning", "enabled"],
				["additionalModelRequestFields", "thinking", "type"],
				["config", "thinkingConfig", "thinkingBudget"],
				["promptMode"],
			].map((path) => payloadField(payload, path));
			if (
				encoded.length === 0 &&
				!nativeControls.some(
					(value) =>
						value === true ||
						value === "enabled" ||
						value === "adaptive" ||
						value === "reasoning" ||
						(typeof value === "number" && value > 0),
				)
			)
				throw unsupported();
			return payload;
		},
	} satisfies Pick<SimpleStreamOptions, "reasoning" | "onPayload">;
}
