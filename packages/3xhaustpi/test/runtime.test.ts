import { spawnSync } from "node:child_process";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configuredPythonConcurrency,
	parseDurableCodingTaskCheckpoint,
	providerCacheSessionId,
	resumeCodingTask,
	runCodingTask,
	semanticOperationTurnIds,
} from "../src/coding-runtime.ts";
import { applyPreparedFiles, type PreparedPatchFile, preparePatchedFiles } from "../src/coding-runtime-patch-apply.ts";
import { FileCredentialStore, SystemCredentialStore } from "../src/credential-store.ts";
import { createStableProjectEvidence } from "../src/project-evidence.ts";
import { createProjectSnapshot } from "../src/project-snapshot.ts";
import { createProviderRuntime, providerCredentialOverride } from "../src/provider-runtime.ts";
import { type ResumeCheckpoint, ThreeXhaustState } from "../src/state.ts";

const temporaryDirectories: string[] = [];
let checkpointSequence = 0;

function approvedPatchCheckpoint(input: {
	readonly project: string;
	readonly statePath: string;
	readonly relativePath: string;
	readonly before: string;
	readonly after: string;
	readonly phase?: "provider-settled" | "patch-approved";
	readonly checkpointApprove?: boolean;
}): ResumeCheckpoint {
	const objective = `update ${input.relativePath}`;
	const snapshot = createProjectSnapshot(input.project, objective);
	const disclosed = snapshot.documents.find(({ relativePath }) => relativePath === input.relativePath) ?? {
		id: "doc_security_target" as const,
		relativePath: input.relativePath,
		content: input.before,
		sha256: "fixture",
	};
	checkpointSequence += 1;
	const sessionId = `session_security_${checkpointSequence}`;
	const requestId = `request_security_${checkpointSequence}`;
	const fingerprint = `fingerprint_security_${checkpointSequence}`;
	const payload = JSON.stringify({
		version: 1,
		phase: input.phase ?? "patch-approved",
		projectRoot: input.project,
		objective,
		approve: input.checkpointApprove ?? true,
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		sessionId,
		requestId,
		fingerprint,
		snapshotSha256: snapshot.sha256,
		snapshotRevision: snapshot.revision,
		documents: [disclosed],
		generation: 1,
		result: {
			output: {
				protocolVersion: 2,
				kind: "patchProposal",
				payload: {
					edits: [{ documentId: disclosed.id, oldText: input.before, newText: input.after }],
					assumptions: [],
					verificationGoals: [],
				},
			},
			usage: { input: 0, output: 0, cacheRead: 0 },
		},
	});
	const state = new ThreeXhaustState(input.statePath);
	state.beginRun({
		projectId: `project_security_${checkpointSequence}`,
		projectPath: input.project,
		sessionId,
		requestId,
		fingerprint,
		payload: JSON.stringify({ objective }),
		checkpoint: payload,
		generation: 1,
	});
	state.markProviderDispatching(requestId, 1);
	state.settleProviderAndCheckpoint(requestId, sessionId, 1, "response_fixture", payload);
	state.completeRun(sessionId, requestId, "failed");
	state.close();
	return {
		sessionId,
		projectPath: input.project,
		payload,
		requestId,
		requestPayload: JSON.stringify({ objective }),
		fingerprint,
		generation: 1,
		outboxState: "settled",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-runtime-test-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("standalone runtime foundations", () => {
	it("accepts only the supported Python read concurrency levels", () => {
		expect(configuredPythonConcurrency({})).toBeUndefined();
		expect(configuredPythonConcurrency({ X3HAUSTPI_PYTHON: "/python" })).toBe(1);
		expect(
			configuredPythonConcurrency({
				X3HAUSTPI_PYTHON: "/python",
				X3HAUSTPI_PYTHON_CONCURRENCY: "4",
			}),
		).toBe(4);
		expect(
			configuredPythonConcurrency({
				X3HAUSTPI_PYTHON: "/python",
				X3HAUSTPI_PYTHON_CONCURRENCY: "8",
			}),
		).toBe(8);
		expect(() =>
			configuredPythonConcurrency({
				X3HAUSTPI_PYTHON: "/python",
				X3HAUSTPI_PYTHON_CONCURRENCY: "2",
			}),
		).toThrow(/1, 4, or 8/u);
	});

	it("uses only non-executing diagnostics when strict mode disables project validation scripts", async () => {
		const project = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		const marker = join(project, "validation-script-ran");
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				scripts: {
					test: "node -e \"require('node:fs').writeFileSync('validation-script-ran','yes')\"",
				},
			}),
		);
		writeFileSync(join(project, "target.txt"), "before\n");
		expect(spawnSync("git", ["init", "--quiet"], { cwd: project }).status).toBe(0);
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath: join(stateDirectory, "state.sqlite"),
			relativePath: "target.txt",
			before: "before\n",
			after: "after\n",
		});

		const result = await runCodingTask({
			projectRoot: project,
			objective: "",
			approve: true,
			strict: true,
			statePath: join(stateDirectory, "state.sqlite"),
			resumeCheckpoint: checkpoint,
		});

		expect(result.diagnostics).toMatchObject({ success: true, command: "git diff --check" });
		expect(readFileSync(join(project, "target.txt"), "utf8")).toBe("after\n");
		expect(() => statSync(marker)).toThrow();
	});

	it("preserves project validation scripts as the default diagnostics behavior", async () => {
		const project = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		const marker = join(project, "default-validation-script-ran");
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				scripts: {
					test: "node -e \"require('node:fs').writeFileSync('default-validation-script-ran','yes')\"",
				},
			}),
		);
		writeFileSync(join(project, "target.txt"), "before\n");
		const statePath = join(stateDirectory, "state.sqlite");
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath,
			relativePath: "target.txt",
			before: "before\n",
			after: "after\n",
		});

		const result = await runCodingTask({
			projectRoot: project,
			objective: "",
			approve: true,
			statePath,
			resumeCheckpoint: checkpoint,
		});

		expect(result.diagnostics?.command).toBe("npm test");
		expect(readFileSync(marker, "utf8")).toBe("yes");
	});

	it("propagates strict diagnostics policy through resumeCodingTask", async () => {
		const project = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({
				scripts: {
					test: "node -e \"require('node:fs').writeFileSync('resume-validation-script-ran','yes')\"",
				},
			}),
		);
		writeFileSync(join(project, "target.txt"), "before\n");
		expect(spawnSync("git", ["init", "--quiet"], { cwd: project }).status).toBe(0);
		const statePath = join(stateDirectory, "state.sqlite");
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath,
			relativePath: "target.txt",
			before: "before\n",
			after: "after\n",
		});

		const result = await resumeCodingTask({
			approve: true,
			strict: true,
			statePath,
			sessionId: checkpoint.sessionId,
		});

		expect(result?.diagnostics?.command).toBe("git diff --check");
		expect(() => statSync(join(project, "resume-validation-script-ran"))).toThrow();
	});

	it("uses current host approval policy instead of a recovered auto-approve flag", async () => {
		const project = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		writeFileSync(join(project, "target.txt"), "before\n");
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath: join(stateDirectory, "state.sqlite"),
			relativePath: "target.txt",
			before: "before\n",
			after: "after\n",
			phase: "provider-settled",
			checkpointApprove: true,
		});
		const requestApproval = vi.fn(async () => false);

		const result = await runCodingTask({
			projectRoot: project,
			objective: "",
			approve: false,
			statePath: join(stateDirectory, "state.sqlite"),
			resumeCheckpoint: checkpoint,
			requestApproval,
		});

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(result.outcome).toBe("rejected");
		expect(readFileSync(join(project, "target.txt"), "utf8")).toBe("before\n");
	});

	it("does not apply a patch after cancellation resolves pending approval", async () => {
		const project = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		const path = join(project, "target.txt");
		const statePath = join(stateDirectory, "state.sqlite");
		writeFileSync(path, "before\n");
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath,
			relativePath: "target.txt",
			before: "before\n",
			after: "after\n",
			phase: "provider-settled",
		});
		const controller = new AbortController();

		await expect(
			runCodingTask({
				projectRoot: project,
				objective: "",
				approve: false,
				statePath,
				resumeCheckpoint: checkpoint,
				signal: controller.signal,
				requestApproval: async () => {
					controller.abort(new Error("cancelled during approval"));
					return true;
				},
			}),
		).rejects.toThrow(/cancelled during approval/u);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("rejects an approved resume when unrelated content contains newText but not oldText", async () => {
		const project = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		const path = join(project, "target.txt");
		const statePath = join(stateDirectory, "state.sqlite");
		writeFileSync(path, "before\n");
		expect(spawnSync("git", ["init", "--quiet"], { cwd: project }).status).toBe(0);
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath,
			relativePath: "target.txt",
			before: "before\n",
			after: "after\n",
		});
		writeFileSync(path, "unrelated\nafter\ncontent\n");

		await expect(
			runCodingTask({
				projectRoot: project,
				objective: "",
				approve: true,
				strict: true,
				statePath,
				resumeCheckpoint: checkpoint,
			}),
		).rejects.toThrow(/oldText is stale/u);
		expect(readFileSync(path, "utf8")).toBe("unrelated\nafter\ncontent\n");
	});

	it("does not overwrite a prepared file that changes before apply", () => {
		const project = temporaryDirectory();
		const path = join(project, "target.txt");
		writeFileSync(path, "before\n");
		const document = createProjectSnapshot(project, "update target.txt").documents.find(
			(candidate) => candidate.relativePath === "target.txt",
		);
		expect(document).toBeDefined();
		if (!document) throw new Error("target fixture was not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: "before\n", newText: "after\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		writeFileSync(path, "raced\n");

		expect(() => applyPreparedFiles(project, prepared)).toThrow(/changed before apply/u);
		expect(readFileSync(path, "utf8")).toBe("raced\n");
	});

	it("does not expose a patch through a hard link created during the write", () => {
		const project = temporaryDirectory();
		const outside = temporaryDirectory();
		const path = join(project, "target.txt");
		const linkedPath = join(outside, "linked.txt");
		writeFileSync(path, "before\n");
		const document = createProjectSnapshot(project, "update target.txt").documents.find(
			(candidate) => candidate.relativePath === "target.txt",
		);
		if (!document) throw new Error("hard-link race fixture was not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: "before\n", newText: "after\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		let linked = false;

		expect(() =>
			applyPreparedFiles(project, prepared, (descriptor, data, offset, length, position) => {
				if (!linked) {
					linked = true;
					linkSync(path, linkedPath);
				}
				return writeSync(descriptor, data, offset, length, position);
			}),
		).toThrow(/multiple links|changed while applying/u);
		expect(readFileSync(linkedPath, "utf8")).toBe("before\n");
	});

	it("rolls back earlier writes without changing their modes when a later file is stale", () => {
		const project = temporaryDirectory();
		const firstPath = join(project, "first.txt");
		const secondPath = join(project, "second.txt");
		writeFileSync(firstPath, "first before\n");
		writeFileSync(secondPath, "second before\n");
		chmodSync(firstPath, 0o751);
		const documents = createProjectSnapshot(project, "update first.txt and second.txt").documents;
		const first = documents.find((document) => document.relativePath === "first.txt");
		const second = documents.find((document) => document.relativePath === "second.txt");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) throw new Error("rollback fixtures were not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [
					{ documentId: first.id, oldText: "first before\n", newText: "first after\n" },
					{ documentId: second.id, oldText: "second before\n", newText: "second after\n" },
				],
				assumptions: [],
				verificationGoals: [],
			},
			new Map(documents.map((document) => [document.id, document])),
		);
		writeFileSync(secondPath, "second raced\n");

		expect(() => applyPreparedFiles(project, prepared)).toThrow(/changed before apply/u);
		expect(readFileSync(firstPath, "utf8")).toBe("first before\n");
		if (process.platform !== "win32") expect(statSync(firstPath).mode & 0o777).toBe(0o751);
		expect(readFileSync(secondPath, "utf8")).toBe("second raced\n");
	});

	it("restores the original file after a partial patch write fails", () => {
		const project = temporaryDirectory();
		const path = join(project, "target.txt");
		writeFileSync(path, "before\n");
		const document = createProjectSnapshot(project, "update target.txt").documents.find(
			(candidate) => candidate.relativePath === "target.txt",
		);
		expect(document).toBeDefined();
		if (!document) throw new Error("partial-write fixture was not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: "before\n", newText: "after content\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		const writeFailure = new Error("injected partial write failure");
		let writes = 0;
		let failure: unknown;

		try {
			applyPreparedFiles(project, prepared, (descriptor, data, offset, length, position) => {
				writes += 1;
				if (writes === 1) return writeSync(descriptor, data, offset, Math.min(4, length), position);
				throw writeFailure;
			});
		} catch (error) {
			failure = error;
		}

		expect(writes).toBe(2);
		expect(failure).toBe(writeFailure);
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});

	it("preserves concurrent content when a staged patch write fails", () => {
		const project = temporaryDirectory();
		const path = join(project, "target.txt");
		writeFileSync(path, "before\n");
		const document = createProjectSnapshot(project, "update target.txt").documents.find(
			(candidate) => candidate.relativePath === "target.txt",
		);
		expect(document).toBeDefined();
		if (!document) throw new Error("partial-write race fixture was not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: "before\n", newText: "after content\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		const writeFailure = new Error("injected partial write failure");
		let writes = 0;
		let failure: unknown;

		try {
			applyPreparedFiles(project, prepared, (descriptor, data, offset, length, position) => {
				writes += 1;
				if (writes === 1) return writeSync(descriptor, data, offset, Math.min(4, length), position);
				writeFileSync(path, "concurrent\n");
				throw writeFailure;
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBe(writeFailure);
		expect(readFileSync(path, "utf8")).toBe("concurrent\n");
	});

	it("preserves a concurrent change when a later conflict makes rollback unsafe", () => {
		const project = temporaryDirectory();
		const firstPath = join(project, "first.txt");
		const secondPath = join(project, "second.txt");
		writeFileSync(firstPath, "first before\n");
		writeFileSync(secondPath, "second before\n");
		const documents = createProjectSnapshot(project, "update first.txt and second.txt").documents;
		const first = documents.find((document) => document.relativePath === "first.txt");
		const second = documents.find((document) => document.relativePath === "second.txt");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) throw new Error("rollback race fixtures were not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [
					{ documentId: first.id, oldText: "first before\n", newText: "first after\n" },
					{ documentId: second.id, oldText: "second before\n", newText: "second after\n" },
				],
				assumptions: [],
				verificationGoals: [],
			},
			new Map(documents.map((document) => [document.id, document])),
		);
		const [firstFile, secondFile] = prepared;
		if (!firstFile || !secondFile) throw new Error("rollback race fixtures were not prepared");
		writeFileSync(secondPath, "second raced\n");
		const racedSecond: PreparedPatchFile = {
			...secondFile,
			document: {
				...secondFile.document,
				get relativePath() {
					writeFileSync(firstPath, "first concurrent\n");
					return secondFile.document.relativePath;
				},
			},
		};

		let failure: unknown;
		try {
			applyPreparedFiles(project, [firstFile, racedSecond]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		const evidence = (failure as AggregateError).errors.map(String).join("\n");
		expect(evidence).toMatch(/changed before apply/u);
		expect(evidence).toMatch(/rollback blocked/u);
		expect(readFileSync(firstPath, "utf8")).toBe("first concurrent\n");
		expect(readFileSync(secondPath, "utf8")).toBe("second raced\n");
	});

	it("does not overwrite same-inode content changed after the initial descriptor comparison", () => {
		const project = temporaryDirectory();
		const path = join(project, "target.txt");
		writeFileSync(path, "before\n");
		const inode = statSync(path).ino;
		const document = createProjectSnapshot(project, "update target.txt").documents.find(
			(candidate) => candidate.relativePath === "target.txt",
		);
		expect(document).toBeDefined();
		if (!document) throw new Error("target fixture was not disclosed");
		const [file] = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: "before\n", newText: "after\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		if (!file) throw new Error("target fixture was not prepared");
		const racedFile: PreparedPatchFile = {
			document: file.document,
			before: file.before,
			get after() {
				writeFileSync(path, "raced\n");
				expect(statSync(path).ino).toBe(inode);
				return file.after;
			},
			existedBefore: file.existedBefore,
		};

		expect(() => applyPreparedFiles(project, [racedFile])).toThrow(/changed before apply/u);
		expect(readFileSync(path, "utf8")).toBe("raced\n");
	});

	it("does not overwrite a target replaced after its prepared content is compared", () => {
		const project = temporaryDirectory();
		const path = join(project, "target.txt");
		writeFileSync(path, "before\n");
		const document = createProjectSnapshot(project, "update target.txt").documents.find(
			(candidate) => candidate.relativePath === "target.txt",
		);
		expect(document).toBeDefined();
		if (!document) throw new Error("target fixture was not disclosed");
		const [file] = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: "before\n", newText: "after\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		if (!file) throw new Error("target fixture was not prepared");
		let replaced = false;
		const racedFile: PreparedPatchFile = {
			document: file.document,
			get before() {
				if (!replaced) {
					renameSync(path, `${path}.original`);
					writeFileSync(path, "replacement\n");
					replaced = true;
				}
				return file.before;
			},
			after: file.after,
			existedBefore: file.existedBefore,
		};

		expect(() => applyPreparedFiles(project, [racedFile])).toThrow(/changed before apply|changed while applying/u);
		expect(readFileSync(path, "utf8")).toBe("replacement\n");
	});

	it("rejects patch targets with symlinked path components without writing outside the project", async () => {
		const project = temporaryDirectory();
		const outside = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		writeFileSync(join(outside, "target.txt"), "before\n");
		symlinkSync(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
		const statePath = join(stateDirectory, "state.sqlite");
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath,
			relativePath: "linked/target.txt",
			before: "before\n",
			after: "escaped\n",
		});

		await expect(
			runCodingTask({
				projectRoot: project,
				objective: "",
				approve: true,
				strict: true,
				statePath,
				resumeCheckpoint: checkpoint,
			}),
		).rejects.toThrow(/symbolic link/iu);
		expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("before\n");
	});

	it("rejects hard-linked patch targets without writing their outside inode", async () => {
		const project = temporaryDirectory();
		const outside = temporaryDirectory();
		const stateDirectory = temporaryDirectory();
		const outsidePath = join(outside, "target.txt");
		const targetPath = join(project, "target.txt");
		writeFileSync(outsidePath, "before\n");
		linkSync(outsidePath, targetPath);
		const statePath = join(stateDirectory, "state.sqlite");
		const checkpoint = approvedPatchCheckpoint({
			project,
			statePath,
			relativePath: "target.txt",
			before: "before\n",
			after: "escaped\n",
		});

		await expect(
			runCodingTask({
				projectRoot: project,
				objective: "",
				approve: true,
				strict: true,
				statePath,
				resumeCheckpoint: checkpoint,
			}),
		).rejects.toThrow(/multiple links/iu);
		expect(readFileSync(outsidePath, "utf8")).toBe("before\n");
	});

	it("resolves a host-provided API credential through the in-memory overlay", async () => {
		const models = createProviderRuntime({
			providerId: "openai",
			credential: { type: "api_key", key: "host-owned-key" },
		});

		expect(await models.checkAuth("openai")).toMatchObject({
			source: "stored credential",
			type: "api_key",
		});
	});

	it("resolves a host-brokered OAuth credential without reading the process credential store", async () => {
		const override = providerCredentialOverride(
			"openai-codex",
			JSON.stringify({
				type: "oauth",
				access: "host-owned-access",
				refresh: "host-owned-refresh",
				expires: Date.now() + 60_000,
			}),
		);
		const models = createProviderRuntime(override);

		expect(await models.checkAuth("openai-codex")).toMatchObject({
			source: "OAuth",
			type: "oauth",
		});
	});

	it("builds a bounded content-addressed snapshot and detects revision changes", () => {
		const project = temporaryDirectory();
		mkdirSync(join(project, "src"));
		writeFileSync(join(project, "src", "login.ts"), "export const LOGIN_ERROR = 'old';\n");
		writeFileSync(join(project, "README.md"), "fixture\n");

		const before = createProjectSnapshot(project, "fix LOGIN_ERROR in login.ts");
		writeFileSync(join(project, "src", "login.ts"), "export const LOGIN_ERROR = 'new';\n");
		const after = createProjectSnapshot(project, "fix LOGIN_ERROR in login.ts");

		expect(before.documents.some(({ relativePath }) => relativePath === "src/login.ts")).toBe(true);
		expect(before.documents.map(({ relativePath }) => relativePath)).toEqual([
			"README.md",
			"src/login.ts",
			"src/server.js",
		]);
		expect(before.stableContext.length).toBeLessThan(18_000);
		expect(before.revision).not.toBe(after.revision);
	});

	it("keeps project evidence order and provider cache affinity stable across objectives", () => {
		const project = temporaryDirectory();
		mkdirSync(join(project, "src"));
		writeFileSync(join(project, "src", "zeta.ts"), "export const zeta = 1;\n");
		writeFileSync(join(project, "src", "alpha.ts"), "export const alpha = 1;\n");
		const first = createProjectSnapshot(project, "inspect zeta");
		const second = createProjectSnapshot(project, "inspect alpha");

		expect(first.documents.map(({ relativePath }) => relativePath)).toEqual([
			"src/alpha.ts",
			"src/zeta.ts",
			"src/server.js",
		]);
		expect(second.documents.map(({ relativePath }) => relativePath)).toEqual(
			first.documents.map(({ relativePath }) => relativePath),
		);
		expect(providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini")).toBe(
			providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini"),
		);
		expect(providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini")).not.toBe(
			providerCacheSessionId(project, "openai-codex", "gpt-5.5"),
		);
		expect(providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini", "inspect alpha")).not.toBe(
			providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini", "inspect zeta"),
		);
		const turnIds = semanticOperationTurnIds(project, "inspect alpha", first.revision);
		expect(semanticOperationTurnIds(project, "inspect alpha", first.revision)).toEqual(turnIds);
		expect(semanticOperationTurnIds(project, "inspect zeta", first.revision)).not.toEqual(turnIds);
	});

	it("bounds deterministic semantic evidence for real-provider calibration", () => {
		const repositoryRoot = resolve(import.meta.dirname, "../../..");
		const evidence = createStableProjectEvidence(repositoryRoot, 128);

		expect(evidence.text).toHaveLength(128);
		expect(() => createStableProjectEvidence(repositoryRoot, 0)).toThrow(/1 to 1,048,576/);
		expect(() => createStableProjectEvidence(repositoryRoot, 1_048_577)).toThrow(/1 to 1,048,576/);
	});

	it("exposes bounded new-file slots for an empty project", () => {
		const project = temporaryDirectory();
		const snapshot = createProjectSnapshot(project, "build a tested todo web app");

		expect(snapshot.documents.map(({ relativePath }) => relativePath)).toEqual([
			"README.md",
			"index.html",
			"package.json",
			"src/app.js",
			"src/server.js",
			"src/styles.css",
			"test/app.test.js",
		]);
		expect(snapshot.documents.every(({ virtual }) => virtual)).toBe(true);
		expect(snapshot.stableContext).toContain("NEW FILE SLOT");
		expect(snapshot.stableContext).toContain("oldText is exactly the marker");
	});

	it.runIf(process.platform !== "win32")("honors the process umask for a newly patched file", () => {
		const project = temporaryDirectory();
		const snapshot = createProjectSnapshot(project, "create README.md");
		const document = snapshot.documents.find(({ relativePath }) => relativePath === "README.md");
		if (!document) throw new Error("new-file mode fixture was not disclosed");
		const prepared = preparePatchedFiles(
			project,
			{
				edits: [{ documentId: document.id, oldText: document.content, newText: "# Private\n" }],
				assumptions: [],
				verificationGoals: [],
			},
			new Map([[document.id, document]]),
		);
		const previousUmask = process.umask(0o077);
		try {
			applyPreparedFiles(project, prepared);
		} finally {
			process.umask(previousUmask);
		}

		expect(statSync(join(project, "README.md")).mode & 0o777).toBe(0o600);
	});

	it("keeps a bounded server new-file slot available in an existing project", () => {
		const project = temporaryDirectory();
		writeFileSync(join(project, "package.json"), '{"scripts":{"start":"node src/server.js"}}');
		const snapshot = createProjectSnapshot(project, "add a static server");
		const server = snapshot.documents.find(({ relativePath }) => relativePath === "src/server.js");

		expect(server).toMatchObject({ virtual: true });
		expect(snapshot.stableContext).toContain("NEW FILE SLOT");
		expect(snapshot.documents).toHaveLength(2);
	});

	it("exposes only requested skill slots and existing skill documents under the hidden skills directory", () => {
		const project = temporaryDirectory();
		mkdirSync(join(project, ".3xhaust", "skills", "deploy-checklist"), { recursive: true });
		mkdirSync(join(project, ".3xhaust", "skills", "notes"), { recursive: true });
		writeFileSync(join(project, "package.json"), "{}\n");
		writeFileSync(join(project, ".env"), "SECRET=value\n");
		writeFileSync(join(project, ".3xhaust", "config.json"), "{}\n");
		writeFileSync(join(project, ".3xhaust", "skills", "deploy-checklist", "SKILL.md"), "# Deploy Checklist\n");
		writeFileSync(join(project, ".3xhaust", "skills", "notes", "draft.txt"), "hidden notes\n");

		const createSkill = createProjectSnapshot(project, "npm-release 스킬 만들어줘");
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).toEqual([
			".3xhaust/skills/deploy-checklist/SKILL.md",
			"package.json",
			".3xhaust/skills/npm-release/SKILL.md",
			"src/server.js",
		]);
		expect(
			createSkill.documents.find(({ relativePath }) => relativePath === ".3xhaust/skills/npm-release/SKILL.md"),
		).toMatchObject({
			virtual: true,
		});
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).not.toContain(".env");
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).not.toContain(".3xhaust/config.json");
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).not.toContain(
			".3xhaust/skills/notes/draft.txt",
		);

		const ambiguous = createProjectSnapshot(project, "create skill npm-release deploy-helper");
		expect(ambiguous.documents.map(({ relativePath }) => relativePath)).not.toContain(
			".3xhaust/skills/npm-release/SKILL.md",
		);

		const invalid = createProjectSnapshot(project, "create skill NPM_Release");
		expect(invalid.documents.map(({ relativePath }) => relativePath)).not.toContain(
			".3xhaust/skills/NPM_Release/SKILL.md",
		);
	});

	it("persists credentials with private file permissions without exposing them in list", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "auth.json");
		const store = new FileCredentialStore(path);
		await store.modify("openai-codex", async () => ({
			type: "oauth",
			access: "secret-access",
			refresh: "secret-refresh",
			expires: Date.now() + 60_000,
		}));

		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toContain("secret-access");
	});

	it("migrates legacy credentials into an OS keyring and leaves only non-secret metadata", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "auth.json");
		const keyring = new Map<string, string>();
		writeFileSync(
			path,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "legacy-secret-access",
					refresh: "legacy-secret-refresh",
					expires: Date.now() + 60_000,
				},
			}),
			{ mode: 0o600 },
		);
		const store = new SystemCredentialStore(path, {
			entryFactory: (providerId) => ({
				getPassword: () => Promise.resolve(keyring.get(providerId)),
				setPassword: async (password) => {
					keyring.set(providerId, password);
				},
				deleteCredential: async () => keyring.delete(providerId),
			}),
		});

		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(await store.read("openai-codex")).toMatchObject({
			type: "oauth",
			access: "legacy-secret-access",
			refresh: "legacy-secret-refresh",
		});
		const metadata = readFileSync(path, "utf8");
		expect(metadata).not.toContain("legacy-secret");
		expect(metadata).toContain('"storage": "os-keyring"');
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

		await store.modify("openai-codex", async (current) => ({
			...current,
			type: "oauth",
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 120_000,
		}));
		expect(await store.read("openai-codex")).toMatchObject({
			access: "rotated-access",
			refresh: "rotated-refresh",
		});
		expect(readFileSync(path, "utf8")).not.toContain("rotated-access");

		await store.delete("openai-codex");
		expect(await store.read("openai-codex")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("lists registered system credentials without opening the OS keyring", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "auth.json");
		let secureEntryReads = 0;
		writeFileSync(
			path,
			JSON.stringify({
				"openai-codex": { type: "oauth", storage: "os-keyring" },
			}),
			{ mode: 0o600 },
		);
		const store = new SystemCredentialStore(path, {
			entryFactory: () => ({
				getPassword: async () => {
					secureEntryReads += 1;
					return undefined;
				},
				setPassword: async () => {},
				deleteCredential: async () => false,
			}),
		});

		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(secureEntryReads).toBe(0);
	});

	it("recovers a running request only when recovery is explicitly requested", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_fixture",
			projectPath: directory,
			sessionId: "session_fixture",
			requestId: "req_fixture",
			fingerprint: "digest_fixture",
			payload: "{}",
			checkpoint: '{"phase":"provider"}',
			generation: 1,
		});
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		expect(recovered.findResumeCheckpoint()).toBeUndefined();
		expect(recovered.inspectWorkspace(directory).chats[0]?.status).toBe("running");
		recovered.recoverInterruptedRuns();
		expect(recovered.findResumeCheckpoint()).toMatchObject({
			sessionId: "session_fixture",
			projectPath: directory,
			payload: '{"phase":"provider"}',
		});
		recovered.close();
	});

	it("claims a queued pre-dispatch checkpoint exactly once", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_claim",
			projectPath: directory,
			sessionId: "session_claim",
			requestId: "req_claim",
			fingerprint: "digest_claim",
			payload: '{"objective":"resume"}',
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		recovered.recoverInterruptedRuns();
		expect(recovered.claimResumeCheckpoint()).toMatchObject({
			sessionId: "session_claim",
			requestId: "req_claim",
			outboxState: "queued",
			generation: 1,
		});
		expect(recovered.claimResumeCheckpoint()).toBeUndefined();
		expect(recovered.inspectWorkspace(directory).chats[0]?.status).toBe("running");
		recovered.close();
	});

	it("never automatically replays an indeterminate provider transmission", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_indeterminate",
			projectPath: directory,
			sessionId: "session_indeterminate",
			requestId: "req_indeterminate",
			fingerprint: "digest_indeterminate",
			payload: '{"objective":"resume"}',
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		state.markProviderDispatching("req_indeterminate", 1);
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		recovered.recoverInterruptedRuns();
		expect(recovered.findResumeCheckpoint()?.outboxState).toBe("indeterminate");
		expect(() => recovered.claimResumeCheckpoint()).toThrow(/indeterminate.*blocked/iu);
		recovered.close();
	});

	it("turns an explicit indeterminate resume into an auditable fresh restart", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_explicit_restart",
			projectPath: directory,
			sessionId: "session_explicit_restart",
			requestId: "req_explicit_restart",
			fingerprint: "digest_explicit_restart",
			payload: '{"objective":"resume explicitly"}',
			checkpoint:
				'{"version":1,"phase":"provider-ready","projectRoot":"fixture","objective":"resume explicitly","approve":false,"provider":"openai-codex","model":"gpt-5.6-terra","sessionId":"session_explicit_restart","requestId":"req_explicit_restart","fingerprint":"digest_explicit_restart","snapshotSha256":"fixture","generation":1}',
			generation: 1,
		});
		state.markProviderDispatching("req_explicit_restart", 1);
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		recovered.recoverInterruptedRuns();
		expect(recovered.claimExplicitResume()).toMatchObject({
			kind: "restart",
			checkpoint: {
				sessionId: "session_explicit_restart",
				requestId: "req_explicit_restart",
				outboxState: "indeterminate",
			},
		});
		expect(recovered.findResumeCheckpoint()).toBeUndefined();
		expect(recovered.inspectWorkspace(directory).requests[0]).toMatchObject({
			id: "req_explicit_restart",
			status: "indeterminate",
		});
		recovered.close();
	});

	it("reads the observationIds array written by follow-up checkpoints", () => {
		const checkpoint: ResumeCheckpoint = {
			sessionId: "session_followup_schema",
			projectPath: "fixture",
			requestId: "request_followup_schema",
			requestPayload: '{"objective":"resume follow-up"}',
			fingerprint: "fingerprint_followup_schema",
			generation: 2,
			outboxState: "indeterminate",
			updatedAt: "2026-08-22T00:00:00.000Z",
			payload: JSON.stringify({
				version: 1,
				phase: "followup-ready",
				projectRoot: "fixture",
				objective: "resume follow-up",
				approve: false,
				provider: "openai-codex",
				model: "gpt-5.6-terra",
				sessionId: "session_followup_schema",
				requestId: "request_followup_schema",
				fingerprint: "fingerprint_followup_schema",
				snapshotSha256: "snapshot_followup_schema",
				generation: 2,
				result: {
					output: {
						protocolVersion: 2,
						kind: "intent",
						payload: {
							kind: "inspect",
							objective: "read package name",
							target: { kind: "documents", documentIds: ["doc_package"], hint: "name" },
							evidenceGoals: ["package name"],
							constraints: [],
							doneWhen: "package name is known",
						},
					},
					usage: { input: 1, output: 1, cacheRead: 0 },
				},
				observationIds: ["obs_package_name"],
			}),
		};

		expect(parseDurableCodingTaskCheckpoint(checkpoint, { explicitRestart: true }).observationIds).toEqual([
			"obs_package_name",
		]);
		const legacyPayload = JSON.parse(checkpoint.payload) as Record<string, unknown>;
		delete legacyPayload.observationIds;
		legacyPayload.observationId = "obs_legacy_package_name";
		expect(
			parseDurableCodingTaskCheckpoint(
				{ ...checkpoint, payload: JSON.stringify(legacyPayload) },
				{ explicitRestart: true },
			).observationIds,
		).toEqual(["obs_legacy_package_name"]);
	});

	it("links one content-addressed observation to repeated independent sessions", () => {
		const directory = temporaryDirectory();
		const state = new ThreeXhaustState(join(directory, "state.sqlite"));
		for (const suffix of ["one", "two"]) {
			state.beginRun({
				projectId: "prj_observation",
				projectPath: directory,
				sessionId: `session_${suffix}`,
				requestId: `request_${suffix}`,
				fingerprint: `fingerprint_${suffix}`,
				payload: "{}",
				checkpoint: '{"phase":"provider-ready"}',
				generation: 1,
			});
			state.recordObservation(`session_${suffix}`, "obs_content_addressed", '{"summary":"same"}');
		}
		expect(() => state.recordObservation("session_two", "obs_content_addressed", '{"summary":"different"}')).toThrow(
			/does not match/iu,
		);
		state.close();
	});

	it("atomically persists a settled provider response checkpoint for replay without resend", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_settled",
			projectPath: directory,
			sessionId: "session_settled",
			requestId: "req_settled",
			fingerprint: "digest_settled",
			payload: '{"objective":"resume"}',
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		state.markProviderDispatching("req_settled", 1);
		state.settleProviderAndCheckpoint(
			"req_settled",
			"session_settled",
			1,
			"response_settled",
			'{"version":1,"phase":"provider-settled","result":{"responseId":"response_settled"}}',
		);
		state.completeRun("session_settled", "req_settled", "failed");
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		expect(recovered.claimResumeCheckpoint()).toMatchObject({
			sessionId: "session_settled",
			outboxState: "settled",
			payload: expect.stringContaining('"provider-settled"'),
		});
		recovered.close();
	});

	it("persists TUI follow-ups in FIFO order and safely restores only an unhanded request", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		const first = state.enqueueTuiRequest({
			requestId: "tui_first",
			projectPath: directory,
			fingerprint: "fingerprint_first",
			objective: "first follow-up",
		});
		const duplicate = state.enqueueTuiRequest({
			requestId: "tui_duplicate",
			projectPath: directory,
			fingerprint: "fingerprint_first",
			objective: "first follow-up",
		});
		const second = state.enqueueTuiRequest({
			requestId: "tui_second",
			projectPath: directory,
			fingerprint: "fingerprint_second",
			objective: "second follow-up",
		});

		expect(first).toMatchObject({ inserted: true, request: { id: "tui_first", position: 1 } });
		expect(duplicate).toMatchObject({ inserted: false, request: { id: "tui_first", position: 1 } });
		expect(second).toMatchObject({ inserted: true, request: { id: "tui_second", position: 2 } });
		expect(
			state.claimNextTuiRequest(directory, {
				ownerId: "host_initial",
				now: "2026-08-23T00:00:00.000Z",
				leaseMs: 1_000,
			}),
		).toMatchObject({
			id: "tui_first",
			objective: "first follow-up",
			status: "running",
		});
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		expect(recovered.listTuiRequests(directory).map((request) => request.status)).toEqual(["running", "queued"]);
		recovered.recoverInterruptedTuiRequests(directory, "2026-08-23T00:00:02.000Z");
		const firstClaim = recovered.claimNextTuiRequest(directory, {
			ownerId: "host_recovered",
			now: "2026-08-23T00:00:02.000Z",
			leaseMs: 1_000,
		});
		expect(firstClaim?.id).toBe("tui_first");
		if (!firstClaim) throw new Error("Expected first recovered TUI request");
		recovered.completeTuiRequest(firstClaim.id, "completed", {
			ownerId: firstClaim.ownerId,
			leaseEpoch: firstClaim.leaseEpoch,
			now: "2026-08-23T00:00:02.250Z",
		});
		const secondClaim = recovered.claimNextTuiRequest(directory, {
			ownerId: "host_recovered",
			now: "2026-08-23T00:00:02.250Z",
			leaseMs: 1_000,
		});
		expect(secondClaim?.id).toBe("tui_second");
		if (!secondClaim) throw new Error("Expected second recovered TUI request");
		recovered.completeTuiRequest(secondClaim.id, "completed", {
			ownerId: secondClaim.ownerId,
			leaseEpoch: secondClaim.leaseEpoch,
			now: "2026-08-23T00:00:02.500Z",
		});
		expect(recovered.listTuiRequests(directory)).toEqual([]);
		recovered.close();
	});

	it("returns project and chat summaries for TUI navigation without mutating runtime state", () => {
		const firstProject = temporaryDirectory();
		const secondProject = temporaryDirectory();
		const state = new ThreeXhaustState(join(temporaryDirectory(), "state.sqlite"));
		for (const [index, project] of [firstProject, secondProject].entries()) {
			const suffix = String(index + 1);
			state.beginRun({
				projectId: `project_${suffix}`,
				projectPath: project,
				sessionId: `session_${suffix}`,
				requestId: `request_${suffix}`,
				fingerprint: `fingerprint_${suffix}`,
				payload: JSON.stringify({ objective: `Investigate project ${suffix}` }),
				checkpoint: '{"version":1,"phase":"provider-ready"}',
				generation: 1,
			});
			if (index === 0) {
				state.markProviderDispatching(`request_${suffix}`, 1);
				state.settleProvider(`request_${suffix}`, `response_${suffix}`);
				state.completeRun(`session_${suffix}`, `request_${suffix}`, "completed");
			}
		}

		const first = state.inspectWorkspace(firstProject);
		expect(first.chats).toEqual([
			expect.objectContaining({
				id: "session_1",
				status: "completed",
				objective: "Investigate project 1",
			}),
		]);
		expect(first.projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: firstProject, chatCount: 1, activeChatCount: 0 }),
				expect.objectContaining({ path: secondProject, chatCount: 1, activeChatCount: 1 }),
			]),
		);
		expect(state.inspectWorkspace(secondProject).chats[0]).toMatchObject({
			id: "session_2",
			status: "running",
			objective: "Investigate project 2",
		});
		state.close();
	});
});
