import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiagnosticsResult {
	readonly success: boolean;
	readonly command: string;
	readonly output: string;
}

export function runDiagnostics(projectRoot: string, strict: boolean): DiagnosticsResult {
	let command = "git diff --check";
	let executable = "git";
	let args = ["diff", "--check"];
	if (!strict && existsSync(join(projectRoot, "package.json"))) {
		const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
			readonly scripts?: Readonly<Record<string, string>>;
		};
		if (packageJson.scripts?.test) {
			command = "npm test";
			executable = process.platform === "win32" ? "npm.cmd" : "npm";
			args = ["test"];
		}
	}
	const result = spawnSync(executable, args, {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 4_194_304,
		env: { ...process.env, CI: "1" },
	});
	return {
		success: result.status === 0,
		command,
		output: `${result.stdout}${result.stderr}`.trim().slice(-16_000),
	};
}
