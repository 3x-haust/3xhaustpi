import { resolveUserDataDirectory } from "./identity.ts";
import { PRODUCT_VERSION } from "./product-identity.ts";
import { initializeGlobalSystemPrompt } from "./resource-loader.ts";
import { runSelfUpdate } from "./self-update.ts";

export function runUpdateCommand(): Promise<void> {
	return runSelfUpdate(PRODUCT_VERSION);
}

export function runSystemPromptInitCommand(): void {
	const prompt = initializeGlobalSystemPrompt(resolveUserDataDirectory());
	console.log(`Created ${prompt.sourcePath}`);
}
