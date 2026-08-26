import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectWorkingTreeReviewEvidence } from "../src/working-tree-review.ts";

describe("collectWorkingTreeReviewEvidence", () => {
	it("captures tracked and untracked changes without modifying them", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-review-evidence-"));
		try {
			execFileSync("git", ["init", "-q", root]);
			execFileSync("git", ["-C", root, "config", "user.email", "qa@example.com"]);
			execFileSync("git", ["-C", root, "config", "user.name", "QA"]);
			writeFileSync(join(root, "tracked.txt"), "before\n");
			execFileSync("git", ["-C", root, "add", "tracked.txt"]);
			execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
			writeFileSync(join(root, "tracked.txt"), "after\n");
			writeFileSync(join(root, "untracked.txt"), "new evidence\n");

			const evidence = await collectWorkingTreeReviewEvidence(root);

			expect(evidence.text).toContain("tracked.txt");
			expect(evidence.text).toContain("-before");
			expect(evidence.text).toContain("+after");
			expect(evidence.text).toContain("untracked.txt");
			expect(evidence.text).toContain("new evidence");
			expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("after\n");
			expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("new evidence\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fingerprints untracked files beyond the rendered evidence limit", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-review-many-"));
		try {
			execFileSync("git", ["init", "-q", root]);
			execFileSync("git", ["-C", root, "config", "user.email", "qa@example.com"]);
			execFileSync("git", ["-C", root, "config", "user.name", "QA"]);
			writeFileSync(join(root, "tracked.txt"), "base\n");
			execFileSync("git", ["-C", root, "add", "tracked.txt"]);
			execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
			for (let index = 0; index < 33; index++) writeFileSync(join(root, `file-${index}.txt`), `value ${index}\n`);
			const before = await collectWorkingTreeReviewEvidence(root);

			writeFileSync(join(root, "file-32.txt"), "changed beyond evidence limit\n");
			const after = await collectWorkingTreeReviewEvidence(root);

			expect(after.revision).not.toBe(before.revision);
			expect(after.text).toContain("additional untracked file");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fingerprints content beyond each rendered file cutoff", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-review-long-"));
		try {
			execFileSync("git", ["init", "-q", root]);
			execFileSync("git", ["-C", root, "config", "user.email", "qa@example.com"]);
			execFileSync("git", ["-C", root, "config", "user.name", "QA"]);
			writeFileSync(join(root, "tracked.txt"), "base\n");
			execFileSync("git", ["-C", root, "add", "tracked.txt"]);
			execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
			const path = join(root, "long.txt");
			writeFileSync(path, `${"a".repeat(20_000)}tail-one`);
			const before = await collectWorkingTreeReviewEvidence(root);

			writeFileSync(path, `${"a".repeat(20_000)}tail-two`);
			const after = await collectWorkingTreeReviewEvidence(root);

			expect(after.revision).not.toBe(before.revision);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
