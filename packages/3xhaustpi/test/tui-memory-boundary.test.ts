import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("TUI memory boundary", () => {
	it("keeps the agent runtime graph out of the idle parent bundle", async () => {
		// Given: the production TUI parent entry and package external boundaries.
		const entry = resolve(import.meta.dirname, "../src/cli-tui.ts");

		// When: esbuild resolves the complete runtime import graph without writing output.
		const result = await build({
			entryPoints: [entry],
			bundle: true,
			platform: "node",
			format: "esm",
			write: false,
			metafile: true,
			external: [
				"node:sqlite",
				"@earendil-works/pi-ai",
				"@earendil-works/pi-ai/*",
				"@earendil-works/pi-coding-agent",
				"@earendil-works/pi-coding-agent/*",
				"@napi-rs/keyring",
			],
		});

		// Then: only the narrow session lookup remains; task runtimes stay behind the worker.
		const inputs = Object.keys(result.metafile.inputs);
		expect(inputs.some((path) => path.endsWith("/agent-runtime-host.ts"))).toBe(false);
		expect(
			Object.values(result.metafile.inputs).some((input) =>
				input.imports.some((dependency) => dependency.path === "@earendil-works/pi-coding-agent"),
			),
		).toBe(false);
	});
});
