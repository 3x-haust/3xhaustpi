import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 2_000_000;
const MAX_EVIDENCE = 512_000;
const MAX_UNTRACKED_FILE = 16_000;
const MAX_UNTRACKED_FILES = 32;

export interface WorkingTreeReviewEvidence {
	readonly text: string;
	readonly revision: string;
}

async function git(projectRoot: string, args: readonly string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", projectRoot, ...args], {
			encoding: "utf8",
			maxBuffer: MAX_GIT_OUTPUT,
		});
		return stdout;
	} catch (cause) {
		const detail =
			cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string"
				? cause.stderr.trim()
				: cause instanceof Error
					? cause.message
					: String(cause);
		throw new Error(`Working-tree review is unavailable: ${detail}`);
	}
}

function bounded(value: string): string {
	if (value.length <= MAX_EVIDENCE) return value;
	return `${value.slice(0, MAX_EVIDENCE)}\n\n[review evidence truncated at ${MAX_EVIDENCE} characters]`;
}

async function workingTreeRevision(projectRoot: string, relativePaths: readonly string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const relativePath of [...new Set(relativePaths)].sort()) {
		hash.update(`path:${relativePath}\0`);
		const absolutePath = join(projectRoot, relativePath);
		try {
			const stat = await lstat(absolutePath);
			hash.update(`mode:${stat.mode}\0size:${stat.size}\0`);
			if (stat.isSymbolicLink()) hash.update(`link:${await readlink(absolutePath)}\0`);
			else if (stat.isFile()) {
				for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
			}
		} catch (cause) {
			hash.update(`missing:${cause instanceof Error ? cause.name : "unknown"}\0`);
		}
	}
	return hash.digest("hex");
}

export async function collectWorkingTreeReviewEvidence(projectRoot: string): Promise<WorkingTreeReviewEvidence> {
	const [status, diff, changedOutput, untrackedOutput] = await Promise.all([
		git(projectRoot, ["status", "--short", "--untracked-files=all"]),
		git(projectRoot, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
		git(projectRoot, ["diff", "--name-only", "-z", "HEAD", "--"]),
		git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	const allUntracked = untrackedOutput.split("\0").filter(Boolean);
	const untracked = allUntracked.slice(0, MAX_UNTRACKED_FILES);
	const files: string[] = [];
	for (const relativePath of untracked) {
		const content = await readFile(join(projectRoot, relativePath));
		if (content.includes(0)) {
			files.push(`--- untracked binary: ${relativePath} (${content.byteLength} bytes)`);
			continue;
		}
		const text = content.toString("utf8");
		files.push(
			[
				`--- untracked: ${relativePath}`,
				text.slice(0, MAX_UNTRACKED_FILE),
				...(text.length > MAX_UNTRACKED_FILE ? ["[file truncated]"] : []),
			].join("\n"),
		);
	}
	if (allUntracked.length > untracked.length) {
		files.push(
			`[${allUntracked.length - untracked.length} additional untracked file(s) omitted from review evidence]`,
		);
	}
	const raw = [
		`STATUS\n${status || "(clean)"}`,
		`DIFF\n${diff || "(none)"}`,
		`UNTRACKED\n${files.join("\n\n") || "(none)"}`,
	].join("\n\n");
	return {
		text: bounded(raw),
		revision: await workingTreeRevision(projectRoot, [...changedOutput.split("\0").filter(Boolean), ...allUntracked]),
	};
}
