import { PRODUCT_VERSION } from "./product-identity.ts";
import { runSelfUpdate } from "./self-update.ts";

export function runUpdateCommand(): Promise<void> {
	return runSelfUpdate(PRODUCT_VERSION);
}
