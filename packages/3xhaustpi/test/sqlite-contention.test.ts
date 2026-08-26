import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreeXhaustState } from "../src/state.ts";

const SIGNAL_TIMEOUT_MS = 5_000;
const directories: string[] = [];

const CHILD_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA journal_mode = WAL;");
database.exec("BEGIN IMMEDIATE");
process.on("message", (message) => {
	if (message !== "parent-attempt") return;
	database.exec("COMMIT");
	process.send("child-released");
});
process.on("message", (message) => {
	if (message === "parent-ack") process.exit(0);
});
process.send("child-ready");
`;

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => finish(() => reject(new Error(`Timed out waiting for child signal: ${expected}`))),
			SIGNAL_TIMEOUT_MS,
		);
		const onMessage = (message: unknown) => {
			if (message === expected) finish(resolve);
		};
		const onError = (error: Error) => finish(() => reject(error));
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(() => reject(new Error(`Child exited before ${expected}: ${code ?? signal}`)));
		const finish = (settle: () => void) => {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
			settle();
		};
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => finish(() => reject(new Error("Timed out waiting for child exit"))),
			SIGNAL_TIMEOUT_MS,
		);
		const onError = (error: Error) => finish(() => reject(error));
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(() => (code === 0 ? resolve() : reject(new Error(`Child exited with ${code ?? signal}`))));
		const finish = (settle: () => void) => {
			clearTimeout(timeout);
			child.off("error", onError);
			child.off("exit", onExit);
			settle();
		};
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

describe("ThreeXhaustState concurrent writers", () => {
	it("waits out cross-process write locks instead of failing with SQLITE_BUSY", async () => {
		const stateDirectory = mkdtempSync(join(tmpdir(), "3xhaustpi-sqlite-"));
		directories.push(stateDirectory);
		const statePath = join(stateDirectory, "state.sqlite");
		const state = new ThreeXhaustState(statePath);
		let child: ChildProcess | undefined;
		try {
			const enqueued = state.enqueueTuiRequest({
				requestId: "req_contention",
				projectPath: "/tmp/3xhaustpi-contention",
				fingerprint: "fp_contention",
				objective: "Hold the queue row across a foreign write lock",
			});
			expect(enqueued.inserted).toBe(true);
			const claim = state.claimNextTuiRequest("/tmp/3xhaustpi-contention", {
				ownerId: "host_contention",
				now: "2026-08-23T00:00:00.000Z",
				leaseMs: 60_000,
			});
			if (!claim) throw new Error("Expected contended TUI request claim");
			child = spawn(process.execPath, ["-e", CHILD_SCRIPT, statePath], {
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			});

			await waitForMessage(child, "child-ready");
			const released = waitForMessage(child, "child-released");
			const exited = waitForExit(child);
			child.send("parent-attempt");
			state.completeTuiRequest("req_contention", "completed", {
				ownerId: claim.ownerId,
				leaseEpoch: claim.leaseEpoch,
				now: "2026-08-23T00:00:01.000Z",
			});
			await released;
			child.send("parent-ack");
			await exited;

			expect(state.listTuiRequests("/tmp/3xhaustpi-contention")).not.toContainEqual(
				expect.objectContaining({ id: "req_contention" }),
			);
		} finally {
			if (child?.exitCode === null) child.kill("SIGKILL");
			state.close();
		}
	});
});
