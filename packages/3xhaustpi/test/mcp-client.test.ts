import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callMcpTool, listMcpTools } from "../src/mcp-client.ts";
import { addMcpServer } from "../src/resource-hub.ts";

const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-mcp-client-"));
	temporaryDirectories.push(path);
	return path;
}

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

describe("MCP stdio client", () => {
	it("initializes a configured server and performs tools/list and tools/call over JSON-RPC stdio", async () => {
		const root = temporaryDirectory();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot, { recursive: true });
		const fixture = resolve(import.meta.dirname, "fixtures/mcp-stdio-fixture.mjs");
		addMcpServer({ projectRoot, id: "fixture", command: process.execPath, args: [fixture], scope: "project" });

		await expect(listMcpTools({ projectRoot, server: "fixture", timeoutMs: 1_000 })).resolves.toEqual([
			{
				name: "echo",
				description: "Echo fixture input",
				inputSchema: { type: "object", properties: { text: { type: "string" } } },
			},
		]);
		await expect(
			callMcpTool({ projectRoot, server: "fixture", tool: "echo", arguments: { text: "hello" }, timeoutMs: 1_000 }),
		).resolves.toEqual({
			content: [
				{ type: "text", text: "echo:hello" },
				{ type: "text", text: '{"tool":"echo","ok":true}' },
			],
		});
	});

	it("terminates an MCP server process tree and escalates when the server ignores SIGTERM", async () => {
		const root = temporaryDirectory();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot, { recursive: true });
		const fixture = resolve(import.meta.dirname, "fixtures/mcp-process-tree-fixture.mjs");
		const readyPath = join(root, "mcp-tree-ready.json");
		addMcpServer({
			projectRoot,
			id: "tree",
			command: process.execPath,
			args: [fixture, root],
			scope: "project",
		});

		await expect(listMcpTools({ projectRoot, server: "tree", timeoutMs: 2_000 })).resolves.toEqual([]);
		await waitForFile(readyPath);
		const tree = JSON.parse(readFileSync(readyPath, "utf8")) as {
			readonly serverPid: number;
			readonly childPid: number;
			readonly grandchildPid: number;
		};
		fixturePids.add(tree.serverPid);
		fixturePids.add(tree.childPid);
		fixturePids.add(tree.grandchildPid);
		expect(() => process.kill(tree.serverPid, 0)).toThrow();
		expect(() => process.kill(tree.childPid, 0)).toThrow();
		expect(() => process.kill(tree.grandchildPid, 0)).toThrow();
	}, 10_000);
});
