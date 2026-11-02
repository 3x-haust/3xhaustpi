import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovedAgentTools } from "../src/agent-approved-tools.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directoryFixture(prefix: string) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function tool(tools: ReturnType<typeof createApprovedAgentTools>, name: string) {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

const context = {
	sessionManager: { getSessionId: () => "session_test", getSessionFile: () => undefined },
} as unknown as ExtensionContext;

function text(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }) {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("host-scoped native agent tools", () => {
	it("reads inside the readable roots and refuses files outside them", async () => {
		const projectRoot = directoryFixture("3xhaustpi-scoped-project-");
		const outside = directoryFixture("3xhaustpi-scoped-outside-");
		writeFileSync(join(projectRoot, "inside.txt"), "inside text", "utf8");
		writeFileSync(join(outside, "secret.txt"), "outside secret", "utf8");
		symlinkSync(join(outside, "secret.txt"), join(projectRoot, "link.txt"));
		const tools = createApprovedAgentTools({
			projectRoot,
			requestApproval: async () => true,
			readableRoots: [projectRoot],
		});
		const read = tool(tools, "read");

		expect(tools.map(({ name }) => name)).toEqual(["read", "bash", "edit", "write"]);
		expect(text(await read.execute("call_in", { path: "inside.txt" }, undefined, undefined, context))).toContain(
			"inside text",
		);
		await expect(
			read.execute("call_out", { path: join(outside, "secret.txt") }, undefined, undefined, context),
		).rejects.toThrow(/limited to the task's workspace/u);
		await expect(read.execute("call_link", { path: "link.txt" }, undefined, undefined, context)).rejects.toThrow(
			/limited to the task's workspace/u,
		);
	});

	it("keeps the builtin read tool when no roots are given", () => {
		const tools = createApprovedAgentTools({ projectRoot: directoryFixture("3xhaustpi-scoped-default-") });
		expect(tools.map(({ name }) => name)).toEqual(["bash", "edit", "write"]);
	});

	it("runs each approved bash command through the host spawn hook", async () => {
		const projectRoot = directoryFixture("3xhaustpi-scoped-bash-");
		const seen: string[] = [];
		const tools = createApprovedAgentTools({
			projectRoot,
			requestApproval: async () => true,
			bashSpawnHook: (spawn) => {
				seen.push(spawn.command);
				return { ...spawn, command: "printf hooked" };
			},
		});

		const result = await tool(tools, "bash").execute(
			"call_bash",
			{ command: "printf original" },
			undefined,
			undefined,
			context,
		);

		expect(seen).toEqual(["printf original"]);
		expect(text(result)).toContain("hooked");
		expect(text(result)).not.toContain("original");
	});
});
