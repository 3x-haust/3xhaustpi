import { TuiRuntimeHost } from "./tui-runtime-host.ts";
import type { TuiRuntimeHooks, TuiRuntimeHostOptions, TuiRuntimeRequest } from "./tui-runtime-protocol.ts";

export { TuiRuntimeHost, TuiRuntimeHostPoisonedError } from "./tui-runtime-host.ts";
export type {
	TuiRuntimeHooks,
	TuiRuntimeHostOptions,
	TuiRuntimeRequest,
} from "./tui-runtime-protocol.ts";
export { createTuiRunRequest } from "./tui-runtime-protocol.ts";

export async function runTuiRuntime(
	request: TuiRuntimeRequest,
	hooks: TuiRuntimeHooks,
	options: TuiRuntimeHostOptions = {},
): Promise<unknown> {
	const host = new TuiRuntimeHost(options);
	try {
		return await host.run(request, hooks);
	} finally {
		await host.close();
	}
}
