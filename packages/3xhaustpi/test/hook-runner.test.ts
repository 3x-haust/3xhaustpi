import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runObserverHooks } from "../src/hook-runner.ts";

const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();
const processTreeFixture = resolve(import.meta.dirname, "fixtures/process-tree-fixture.mjs");

function waitForFile(path: string): Promise<void> {
	return new Promise((resolveFile, reject) => {
		let finished = false;
		const filename = basename(path);
		const watcher = watch(dirname(path), (_event, changed) => {
			if ((changed === null || String(changed) === filename) && existsSync(path)) finish(resolveFile);
		});
		const timeout = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${filename}`))), 3_000);
		const finish = (settle: () => void) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			watcher.close();
			settle();
		};
		watcher.once("error", (error) => finish(() => reject(error)));
		if (existsSync(path)) finish(resolveFile);
	});
}

afterEach(() => {
	for (const pid of fixturePids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
		}
	}
	fixturePids.clear();
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("observer hooks", () => {
	it("runs without a shell and exposes only sanitized event fields", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-hook-"));
		temporaryDirectories.push(root);
		const output = join(root, "event.json");
		const script = join(root, "capture.mjs");
		writeFileSync(
			script,
			`import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.argv[2], JSON.stringify({ event: JSON.parse(input), env: process.env }));
`,
		);
		chmodSync(script, 0o755);

		const outcomes = await runObserverHooks(
			[
				{
					id: "capture",
					event: "session.completed",
					command: process.execPath,
					args: [script, output],
					scope: "user",
					sourcePath: script,
				},
			],
			{
				type: "session.completed",
				sessionId: "session_test",
				outcome: "completed",
				decision: "completionSuggestion",
				usage: { input: 10, output: 5, cacheRead: 2 },
			},
			{ cwd: root, timeoutMs: 2_000 },
		);

		expect(outcomes).toEqual([{ id: "capture", status: "completed", exitCode: 0 }]);
		const captured = JSON.parse(readFileSync(output, "utf8")) as {
			event: Record<string, unknown>;
			env: Record<string, string>;
		};
		expect(captured.event).toEqual({
			schemaVersion: 1,
			type: "session.completed",
			sessionId: "session_test",
			outcome: "completed",
			decision: "completionSuggestion",
			usage: { input: 10, output: 5, cacheRead: 2 },
		});
		expect(captured.env.OPENAI_API_KEY).toBeUndefined();
		expect(captured.env.NPM_TOKEN).toBeUndefined();
	});

	it("terminates a hook's child and grandchild when the observer times out", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-hook-tree-"));
		temporaryDirectories.push(root);
		const readyPath = join(root, "tree-ready.json");
		const ready = waitForFile(readyPath);

		const execution = runObserverHooks(
			[
				{
					id: "tree",
					event: "session.completed",
					command: process.execPath,
					args: [processTreeFixture, root],
					scope: "user",
					sourcePath: processTreeFixture,
				},
			],
			{
				type: "session.completed",
				sessionId: "session_tree",
				outcome: "completed",
				decision: "completionSuggestion",
				usage: { input: 1, output: 1, cacheRead: 0 },
			},
			{ cwd: root, timeoutMs: 500 },
		);
		await ready;
		const tree = JSON.parse(readFileSync(readyPath, "utf8")) as {
			readonly childPid: number;
			readonly grandchildPid: number;
		};
		fixturePids.add(tree.childPid);
		fixturePids.add(tree.grandchildPid);
		await expect(execution).resolves.toEqual([{ id: "tree", status: "timed-out" }]);
		expect(() => process.kill(tree.childPid, 0)).toThrow();
		expect(() => process.kill(tree.grandchildPid, 0)).toThrow();
	}, 10_000);
});
