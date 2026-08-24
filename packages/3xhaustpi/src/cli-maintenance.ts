import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { ThreeXhaustCommand } from "./args.ts";
import { runNpmLogin, runNpmPublish } from "./npm-workflow.ts";
import { PRODUCT_VERSION } from "./product-identity.ts";
import { runSelfUpdate } from "./self-update.ts";

type NpmCommand = Extract<ThreeXhaustCommand, { readonly kind: "npm-login" | "npm-publish" }>;

function asidePath(): string {
	const result = spawnSync("which", ["aside"], { encoding: "utf8", timeout: 3_000 });
	const path = result.stdout.trim();
	if (result.status !== 0 || !path) throw new Error("Aside CLI is not installed or unavailable on PATH");
	return path;
}

function confirmPublish(review: {
	readonly account: string;
	readonly registry: string;
	readonly packageName: string;
	readonly version: string;
}): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
	console.log(
		[
			"",
			"npm publish review",
			`  account   ${review.account}`,
			`  registry  ${review.registry}`,
			`  package   ${review.packageName}@${review.version}`,
		].join("\n"),
	);
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		readline.question("Publish this package? [y/N] ", (answer) => {
			readline.close();
			resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
		});
	});
}

export async function runNpmCommand(command: NpmCommand, project: string): Promise<void> {
	if (command.kind === "npm-login") {
		await runNpmLogin({ account: command.account, asidePath: asidePath(), cwd: project });
		return;
	}
	await runNpmPublish({
		account: command.account,
		asidePath: asidePath(),
		cwd: project,
		confirm: confirmPublish,
	});
}

export function runUpdateCommand(): Promise<void> {
	return runSelfUpdate(PRODUCT_VERSION);
}
