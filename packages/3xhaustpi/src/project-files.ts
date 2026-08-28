import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "artifacts", "node_modules"]);
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function resolveRipgrepPath(): string | null {
	const agentRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const managedRipgrep = join(agentRoot, "bin", process.platform === "win32" ? "rg.exe" : "rg");
	if (existsSync(managedRipgrep)) return managedRipgrep;
	const systemRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" });
	return systemRipgrep.error ? null : "rg";
}

export interface ProjectSearchResult {
	readonly status: "completed" | "failed" | "timed-out";
	readonly lines: readonly string[];
	readonly exitCode?: number | null;
}

function walkProjectFiles(projectRoot: string): readonly string[] {
	const paths: string[] = [];
	const visit = (relativeDirectory: string): void => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(join(projectRoot, relativeDirectory), { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(relativePath);
			} else if (entry.isFile()) {
				paths.push(relativePath);
			}
		}
	};
	visit("");
	return paths;
}

export function listProjectFilePaths(
	projectRoot: string,
	ripgrepPath: string | null = resolveRipgrepPath(),
): readonly string[] {
	if (!ripgrepPath) return walkProjectFiles(projectRoot);
	const result = spawnSync(
		ripgrepPath,
		["--files", "-g", "!node_modules/**", "-g", "!.git/**", "-g", "!artifacts/**"],
		{
			cwd: projectRoot,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 4_194_304,
		},
	);
	if (result.status !== 0 && result.status !== 1) {
		throw new Error(result.stderr?.trim() || "Project file listing failed");
	}
	return (result.stdout ?? "")
		.split("\n")
		.map((path) => path.trim())
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right, "en"));
}

export function searchProjectFiles(
	projectRoot: string,
	query: string,
	timeoutMs: number,
	ripgrepPath: string | null = resolveRipgrepPath(),
): ProjectSearchResult {
	if (ripgrepPath) {
		const result = spawnSync(ripgrepPath, ["-n", "--fixed-strings", "--glob", "!node_modules/**", query, "."], {
			cwd: projectRoot,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 1_048_576,
		});
		if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
			return { status: "timed-out", lines: [] };
		}
		return {
			status: result.status === 0 || result.status === 1 ? "completed" : "failed",
			lines: (result.stdout ?? "").trim().split("\n").filter(Boolean),
			exitCode: result.status,
		};
	}

	const deadline = Date.now() + timeoutMs;
	const lines: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (const relativePath of walkProjectFiles(projectRoot)) {
		if (Date.now() > deadline) return { status: "timed-out", lines: [] };
		try {
			const path = join(projectRoot, relativePath);
			if (statSync(path).size > MAX_FILE_BYTES) continue;
			const content = decoder.decode(readFileSync(path)).replace(/\r\n?/gu, "\n");
			for (const [index, line] of content.split("\n").entries()) {
				if (!line.includes(query)) continue;
				lines.push(`./${relativePath}:${index + 1}:${line.trimEnd()}`);
				if (lines.length >= MAX_MATCHES) return { status: "completed", lines };
			}
		} catch {}
	}
	return { status: "completed", lines };
}
