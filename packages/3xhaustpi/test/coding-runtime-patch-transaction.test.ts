import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPatchTransaction,
	type PatchTransactionBoundary,
	type TransactionalPatchFile,
} from "../src/coding-runtime-patch-transaction.ts";

const temporaryDirectories: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-windows-patch-"));
	temporaryDirectories.push(root);
	return root;
}

function boundary(root: string, verify?: PatchTransactionBoundary["verify"]): PatchTransactionBoundary {
	return {
		path: (relativePath) => join(root, relativePath),
		verify:
			verify ??
			((path) => {
				try {
					return lstatSync(path);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
					throw error;
				}
			}),
		ensureParent: (path) => mkdirSync(dirname(path), { recursive: true }),
		platform: "win32",
	};
}

function patch(relativePath: string, before: string, after: string): TransactionalPatchFile {
	return {
		document: { relativePath },
		before,
		after,
		existedBefore: true,
	};
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Windows patch transactions", () => {
	it("replaces an existing file through a verified no-clobber install", () => {
		const root = fixture();
		const path = join(root, "target.txt");
		writeFileSync(path, "before\n");

		applyPatchTransaction([patch("target.txt", "before\n", "after\n")], boundary(root));

		expect(readFileSync(path, "utf8")).toBe("after\n");
		expect(readdirSync(root)).toEqual(["target.txt"]);
	});

	it("restores an earlier file when a later target is stale", () => {
		const root = fixture();
		const firstPath = join(root, "first.txt");
		const secondPath = join(root, "second.txt");
		writeFileSync(firstPath, "first before\n");
		writeFileSync(secondPath, "second raced\n");

		expect(() =>
			applyPatchTransaction(
				[
					patch("first.txt", "first before\n", "first after\n"),
					patch("second.txt", "second before\n", "second after\n"),
				],
				boundary(root),
			),
		).toThrow(/changed before apply/u);
		expect(readFileSync(firstPath, "utf8")).toBe("first before\n");
		expect(readFileSync(secondPath, "utf8")).toBe("second raced\n");
		expect(readdirSync(root).sort()).toEqual(["first.txt", "second.txt"]);
	});

	it("preserves both the original and a concurrent replacement", () => {
		const root = fixture();
		const path = join(root, "target.txt");
		writeFileSync(path, "before\n");
		let replaced = false;
		const inspect = boundary(root).verify;

		expect(() =>
			applyPatchTransaction(
				[patch("target.txt", "before\n", "after\n")],
				boundary(root, (candidate) => {
					const stats = inspect(candidate);
					if (!replaced && candidate !== path && candidate.endsWith(".patch") && stats) {
						replaced = true;
						writeFileSync(path, "concurrent\n");
					}
					return stats;
				}),
			),
		).toThrow(/original preserved at/u);
		expect(readFileSync(path, "utf8")).toBe("concurrent\n");
		const preserved = readdirSync(root).filter((name) => name !== "target.txt");
		expect(preserved).toHaveLength(1);
		const [preservedName] = preserved;
		if (!preservedName) throw new Error("original patch target was not preserved");
		expect(readFileSync(join(root, preservedName), "utf8")).toBe("before\n");
		expect(existsSync(path)).toBe(true);
	});
});
