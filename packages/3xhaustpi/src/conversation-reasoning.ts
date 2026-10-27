import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ConversationInput } from "./coding-runtime-contracts.ts";
import { declaresReasoningOff, disabledReasoningPayload, payloadField } from "./conversation-reasoning-off.ts";

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
	if (
		!model.reasoning ||
		(effort === "none"
			? !supported.includes("off") || !declaresReasoningOff(model)
			: level === undefined || level === "off")
	) {
		throw unsupported();
	}
	return {
		...(level !== undefined && level !== "off" ? { reasoning: level } : {}),
		onPayload: (payload: unknown) => {
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw unsupported();
			if (effort === "none") {
				const disabled = disabledReasoningPayload(model, payload);
				if (disabled === undefined) throw unsupported();
				return disabled;
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
