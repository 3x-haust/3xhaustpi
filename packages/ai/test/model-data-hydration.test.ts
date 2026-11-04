import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
				fileURLToPath(new URL("../catalog/generate.ts", import.meta.url)),
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
