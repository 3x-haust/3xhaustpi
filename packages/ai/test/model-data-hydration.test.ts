import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("hydrates the committed catalog when network access is unavailable", () => {
	// Given a process that rejects every external catalog request.
	const root = mkdtempSync(join(tmpdir(), "pi-offline-hydration-"));
	const hook = join(root, "offline.mjs");
	writeFileSync(hook, 'globalThis.fetch = () => { throw new Error("Network access forbidden"); };\n');
	try {
		// When the CI hydration command consumes the checked-in snapshot.
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(hook).href,
				fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url)),
				"--strict",
				"--data-only",
			],
			{ encoding: "utf8", timeout: 10000 },
		);

		// Then validation succeeds without contacting a remote service.
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("generates Kimi Coding from the catalog matching the configured China endpoint", () => {
	// Given distinct regional catalogs and no external network access.
	const root = mkdtempSync(join(tmpdir(), "pi-kimi-catalog-"));
	const hook = join(root, "catalog.mjs");
	const model = { tool_call: true, limit: { context: 262144, output: 32768 } };
	const catalog = {
		"kimi-code-plan-cn": { models: { "kimi-for-coding": model } },
		"kimi-code-plan-global": { models: { "global-only": model } },
	};
	writeFileSync(
		hook,
		`globalThis.fetch = async url => new Response(JSON.stringify(url === "https://models.dev/api.json" ? ${JSON.stringify(catalog)} : { data: [] }));\n`,
	);
	try {
		// When the public JSON generator refreshes the catalog.
		const output = join(root, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(hook).href,
				fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url)),
				"--strict",
				"--json-only",
				"--json-output",
				output,
			],
			{ encoding: "utf8", timeout: 10000 },
		);

		// Then the provider retains its Anthropic endpoint and regional model IDs.
		expect(result.status, result.stderr).toBe(0);
		const models: unknown = JSON.parse(readFileSync(join(output, "providers", "kimi-coding.json"), "utf8"));
		expect(models).toEqual({
			"kimi-for-coding": expect.objectContaining({
				api: "anthropic-messages",
				provider: "kimi-coding",
				baseUrl: "https://api.kimi.com/coding",
			}),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
