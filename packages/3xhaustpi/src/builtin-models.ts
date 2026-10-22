import type { Api, CreateModelsOptions, Model, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels as upstreamBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { OPENAI_MODELS } from "../../ai/src/providers/openai.models.ts";
import { OPENAI_CODEX_MODELS } from "../../ai/src/providers/openai-codex.models.ts";

/** Ship the reviewed GPT-6 snapshot even when the published pi-ai dependency is older. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = upstreamBuiltinModels(options);
	for (const catalog of [OPENAI_MODELS, OPENAI_CODEX_MODELS]) {
		const additions: Model<Api>[] = Object.values(catalog).filter((model) => model.id.startsWith("gpt-6"));
		const provider = models.getProvider(additions[0]?.provider ?? "");
		if (!provider) continue;
		const ids = new Set(additions.map((model) => model.id));
		models.setProvider({
			...provider,
			getModels: () => [...provider.getModels().filter((model) => !ids.has(model.id)), ...additions],
		});
	}
	return models;
}
